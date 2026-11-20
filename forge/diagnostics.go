package main

// Opt-in, out-of-band diagnostics. The normal launcher never enables this;
// measurements do not add an endpoint, branch, or counter to the request path.
import (
	"bufio"
	"os"
	"runtime"
	"runtime/pprof"
	"strconv"
	"strings"
	"syscall"
)

func startDiagnostics() {
	if os.Getenv("FORGE_DIAGNOSTICS") != "1" {
		return
	}
	go func() {
		var profile *os.File
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			command := scanner.Text()
			switch {
			case command == "stats":
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				var usage syscall.Rusage
				syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
				var buffer [256]byte
				data := append(buffer[:0], `METRICS {"Mallocs":`...)
				data = strconv.AppendUint(data, m.Mallocs, 10)
				data = append(data, `,"Bytes":`...)
				data = strconv.AppendUint(data, m.TotalAlloc, 10)
				data = append(data, `,"GC":`...)
				data = strconv.AppendUint(data, uint64(m.NumGC), 10)
				data = append(data, `,"CPUus":`...)
				data = strconv.AppendInt(data, usage.Utime.Sec*1000000+usage.Utime.Usec+usage.Stime.Sec*1000000+usage.Stime.Usec, 10)
				os.Stderr.Write(append(data, '}', '\n'))
			case strings.HasPrefix(command, "profile "):
				var err error
				profile, err = os.Create(strings.TrimPrefix(command, "profile "))
				if err != nil {
					panic(err)
				}
				if err = pprof.StartCPUProfile(profile); err != nil {
					panic(err)
				}
				os.Stderr.WriteString("PROFILE started\n")
			case command == "stop":
				pprof.StopCPUProfile()
				if profile != nil {
					profile.Close()
					profile = nil
				}
				os.Stderr.WriteString("PROFILE stopped\n")
			}
		}
	}()
}
