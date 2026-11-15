// What OpenTUI's MinGW objects take from MinGW's runtime that an MSVC program cannot.
// scripts/bundle-windows-runtime.zig compiles this, with the CRT import pointers it generates,
// into opentui-static.lib. MinGW's POSIX names
// are import library aliases of the UCRT's underscored functions, which Microsoft's import
// libraries lack, and winpthreads sets up its clocks in a constructor that MSVC's start-up code
// never runs. No headers: MinGW's declare some of these names as imports.
#include <stdint.h>

// MinGW's struct timespec with a 64-bit time_t.
struct ot_timespec64 {
    int64_t tv_sec;
    long tv_nsec;
};

int _close(int fd);
int _read(int fd, void *buffer, unsigned count);
int _write(int fd, const void *buffer, unsigned count);
int _isatty(int fd);
void *_fdopen(int fd, const char *mode);
int _fstat64(int fd, void *stat);
char *_strdup(const char *text);
int _stricmp(const char *a, const char *b);
__declspec(dllimport) int __stdcall QueryPerformanceCounter(int64_t *count);
__declspec(dllimport) int __stdcall QueryPerformanceFrequency(int64_t *frequency);
__declspec(dllimport) void __stdcall GetSystemTimePreciseAsFileTime(uint64_t *time);
__declspec(dllimport) void __stdcall Sleep(uint32_t milliseconds);
__declspec(dllimport) void *__stdcall GetModuleHandleW(const unsigned short *name);
__declspec(dllimport) void *__stdcall GetProcAddress(void *module, const char *name);

// Zig's stack traces (std.debug.SelfInfo) track loaded DLLs with LdrRegisterDllNotification, which
// ntdll.dll exports and the Windows SDK's ntdll.lib does not: look it up at run time, as Zig does
// for its own MSVC static libraries. STATUS_NOT_IMPLEMENTED should ntdll.dll ever lack it.
typedef long(__stdcall *ot_ldr_register_dll_notification)(unsigned long, void *, void *, void **);
long __stdcall LdrRegisterDllNotification(unsigned long flags, void *callback, void *context, void **cookie) {
    ot_ldr_register_dll_notification real = (ot_ldr_register_dll_notification)GetProcAddress(
        GetModuleHandleW((const unsigned short *)L"ntdll.dll"), "LdrRegisterDllNotification");
    return real ? real(flags, callback, context, cookie) : (long)0xC0000002;
}

int close(int fd) { return _close(fd); }
int read(int fd, void *buffer, unsigned count) { return _read(fd, buffer, count); }
int write(int fd, const void *buffer, unsigned count) { return _write(fd, buffer, count); }
int isatty(int fd) { return _isatty(fd); }
void *fdopen(int fd, const char *mode) { return _fdopen(fd, mode); }
int fstat64(int fd, void *stat) { return _fstat64(fd, stat); }
char *strdup(const char *text) { return _strdup(text); }
int strcasecmp(const char *a, const char *b) { return _stricmp(a, b); }

// For FFmpeg's av_usleep. Sleep takes whole milliseconds; rounding up keeps a sleep from being shorter than asked.
int nanosleep64(const struct ot_timespec64 *request, struct ot_timespec64 *remain) {
    Sleep((uint32_t)(request->tv_sec * 1000 + (request->tv_nsec + 999999) / 1000000));
    if (remain) {
        remain->tv_sec = 0;
        remain->tv_nsec = 0;
    }
    return 0;
}

// For FFmpeg's av_gettime_relative, which asks for CLOCK_MONOTONIC (1). CLOCK_REALTIME (0) is the only other one.
int clock_gettime64(int clock, struct ot_timespec64 *time) {
    if (clock == 1) {
        int64_t count, frequency;
        QueryPerformanceCounter(&count);
        QueryPerformanceFrequency(&frequency);
        time->tv_sec = count / frequency;
        time->tv_nsec = (long)(count % frequency * 1000000000 / frequency);
        return 0;
    }
    if (clock != 0) return -1;
    // 100 ns ticks since 1601.
    uint64_t ticks;
    GetSystemTimePreciseAsFileTime(&ticks);
    ticks -= 116444736000000000ull;
    time->tv_sec = (int64_t)(ticks / 10000000);
    time->tv_nsec = (long)(ticks % 10000000 * 100);
    return 0;
}
