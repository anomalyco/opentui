// macOS tty probe for the stdout writer thread (opentui #1858, PR 4).
//
// Makes the writer's syscalls on a pty slave and checks the two things PR 4 needs:
//   1. interleave: one blocking write(2) of a 64 KiB ticket is never split by another
//      writer's bytes while the output queue is full and the write sleeps;
//   2. poll/select: on an O_NONBLOCK tty that returned EAGAIN, poll(POLLOUT) and select
//      block until the far side drains, then report writable (not POLLNVAL or an error).
// One line per case, PASS or FAIL. Exits 0 unless setup fails, so every case shows.
//
// Build: cc -O2 -pthread macos-tty-probe.c -o macos-tty-probe   (add -lutil on glibc < 2.34)
// Run:   ./macos-tty-probe [iterations]   (default 100 per interleave case)
// -DPROBE_A_CHUNK=N makes the ticket N-byte writes: a deliberate failure, to prove the scan.
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#endif

#ifndef PROBE_A_CHUNK
#define PROBE_A_CHUNK 0
#endif

#define A_LEN (64 * 1024)
#define MARK_LEN 6
#define SPLITS_KEPT 8
#define BOUNDS_MAX 4096

// A's bytes are lowercase only; markers start with 0x01 and use no lowercase. The queue is
// prefilled with FILLER, which the scan skips: a partial non-blocking fill write cuts no marker.
#define FILLER '.'
static const unsigned char mark_thread[MARK_LEN] = {0x01, 'T', 'H', 'R', 'D', 0x02};
static const unsigned char mark_proc[MARK_LEN] = {0x01, 'P', 'R', 'O', 'C', 0x02};
static unsigned char a_bytes[A_LEN];

static int64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

static void sleep_us(long us) {
    struct timespec ts = {us / 1000000, (us % 1000000) * 1000};
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
    }
}

static void die(const char *what) {
    fprintf(stderr, "probe setup failed: %s: %s\n", what, strerror(errno));
    exit(2);
}

static void set_nonblock(int fd, int on) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, on ? flags | O_NONBLOCK : flags & ~O_NONBLOCK) < 0) die("fcntl");
}

static void open_raw_pty(int *master, int *slave) {
    if (openpty(master, slave, NULL, NULL, NULL) != 0) die("openpty");
    struct termios t;
    if (tcgetattr(*slave, &t) != 0) die("tcgetattr");
    cfmakeraw(&t);
    if (tcsetattr(*slave, TCSANOW, &t) != 0) die("tcsetattr");
    set_nonblock(*master, 1);
}

// Writes `len` bytes to fd until EAGAIN. Returns the bytes written.
static long fill_until_eagain(int fd, const unsigned char *block, size_t len) {
    long total = 0;
    for (;;) {
        ssize_t n = write(fd, block, len);
        if (n > 0) {
            total += n;
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return total;
        die("fill write");
    }
}

// ---- Streaming scan of the master's output ----

typedef struct {
    int a_active;
    long a_seen;  // A bytes seen in this iteration
    int mpos;     // bytes of the marker in progress
    const unsigned char *mark;
    // Results, summed over the case.
    long splits;           // markers between A's first and last byte
    long splits_at_call;   // of those, at a boundary between two of A's write calls
    long a_mismatch;       // A bytes out of order or wrong
    long broken_markers;   // a marker whose 6 bytes were not contiguous
    long stray;            // bytes that are neither A nor a marker
    long kept[SPLITS_KEPT];
    int kept_count;
    long split_iterations; // iterations with at least one split
    // This iteration's split offsets, checked against A's call boundaries after the join.
    long it_offsets[BOUNDS_MAX];
    int it_count;
} Scan;

static void scan_marker_done(Scan *s) {
    if (s->a_active && s->a_seen > 0 && s->a_seen < A_LEN) {
        s->splits++;
        if (s->it_count < BOUNDS_MAX) s->it_offsets[s->it_count++] = s->a_seen;
        if (s->kept_count < SPLITS_KEPT) s->kept[s->kept_count++] = s->a_seen;
    }
}

static void scan_byte(Scan *s, unsigned char c) {
    if (s->mpos > 0) {
        if (c == s->mark[s->mpos] || (s->mpos == 1 && (c == mark_thread[1] || c == mark_proc[1]))) {
            if (s->mpos == 1) s->mark = c == mark_thread[1] ? mark_thread : mark_proc;
            if (++s->mpos == MARK_LEN) {
                s->mpos = 0;
                scan_marker_done(s);
            }
            return;
        }
        s->broken_markers++;
        s->mpos = 0;
    }
    if (c == 0x01) {
        s->mpos = 1;
        s->mark = mark_thread;
    } else if (c == FILLER) {
    } else if (c >= 'a' && c <= 'z') {
        if (!s->a_active || s->a_seen >= A_LEN) {
            s->stray++;
            return;
        }
        if (c != a_bytes[s->a_seen]) s->a_mismatch++;
        s->a_seen++;
    } else {
        s->stray++;
    }
}

// Reads up to `budget` bytes from the master. Returns the bytes read.
static long drain(int master, Scan *s, long budget) {
    unsigned char buf[16384];
    long total = 0;
    while (total < budget) {
        long want = budget - total;
        if (want > (long)sizeof buf) want = sizeof buf;
        ssize_t n = read(master, buf, (size_t)want);
        if (n <= 0) break;
        for (ssize_t i = 0; i < n; i++) scan_byte(s, buf[i]);
        total += n;
    }
    return total;
}

// ---- Writer A: the writer's writeStep loop ----

typedef struct {
    int fd;
    atomic_int in_write;
    atomic_int done;
    int failed;
    long calls;
    long polls;
    long poll_bad;  // poll returned an error or POLLNVAL/POLLERR
    int64_t ns;
    // Cumulative byte counts where one write call ended and the next began.
    long bounds[BOUNDS_MAX];
    int bounds_count;
} Ticket;

// A split at a call boundary means the kernel kept each call whole; one inside a call means it did not.
static void count_call_splits(Scan *s, const Ticket *t) {
    if (s->it_count > 0) s->split_iterations++;
    for (int i = 0; i < s->it_count; i++)
        for (int j = 0; j < t->bounds_count; j++)
            if (t->bounds[j] == s->it_offsets[i]) {
                s->splits_at_call++;
                break;
            }
    s->it_count = 0;
}

// As the writer: every signal blocked but SIGTTOU and the synchronous faults; one write per
// ticket; a partial count writes the rest; EINTR retries; EAGAIN waits in poll(POLLOUT, -1).
static void *writer_a(void *arg) {
    Ticket *t = arg;
    sigset_t blocked;
    sigfillset(&blocked);
    int keep[] = {SIGTTOU, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
    for (size_t i = 0; i < sizeof keep / sizeof keep[0]; i++) sigdelset(&blocked, keep[i]);
    pthread_sigmask(SIG_BLOCK, &blocked, NULL);

    long done = 0;
    int64_t start = now_ns();
    atomic_store(&t->in_write, 1);
    while (done < A_LEN) {
        size_t want = (size_t)(A_LEN - done);
        if (PROBE_A_CHUNK > 0 && want > PROBE_A_CHUNK) want = PROBE_A_CHUNK;
        ssize_t n = write(t->fd, a_bytes + done, want);
        t->calls++;
        if (n > 0) {
            done += n;
            if (done < A_LEN && t->bounds_count < BOUNDS_MAX) t->bounds[t->bounds_count++] = done;
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd p = {.fd = t->fd, .events = POLLOUT};
            int r = poll(&p, 1, -1);
            t->polls++;
            if (r < 0 || (p.revents & (POLLNVAL | POLLERR))) t->poll_bad++;
            continue;
        }
        t->failed = 1;
        break;
    }
    t->ns = now_ns() - start;
    atomic_store(&t->done, 1);
    return NULL;
}

// ---- Writer B: 6-byte markers in a loop ----

typedef struct {
    int fd;
    _Atomic long count;
    atomic_int stop;
    atomic_int exited;
} Marker;

static void *writer_b_thread(void *arg) {
    Marker *m = arg;
    while (!atomic_load(&m->stop)) {
        if (write(m->fd, mark_thread, MARK_LEN) == MARK_LEN) atomic_fetch_add(&m->count, 1);
    }
    atomic_store(&m->exited, 1);
    return NULL;
}

// Waits until B's count stops moving: B sleeps inside write on a full queue.
static int wait_b_blocked(Marker *m) {
    int64_t deadline = now_ns() + 10LL * 1000000000;
    long last = atomic_load(&m->count);
    int still = 0;
    while (now_ns() < deadline) {
        sleep_us(1000);
        long c = atomic_load(&m->count);
        still = c == last ? still + 1 : 0;
        last = c;
        if (still >= 3) return 1;
    }
    return 0;
}

// ---- Case 1: interleaving ----

typedef struct {
    const char *name;
    long chunk;
    long sleep;
} Rate;

static const Rate rates[] = {
    {"slow", 64, 50},
    {"medium", 512, 100},
    {"fast", 4096, 1000},
};

static void print_scan(const Scan *s) {
    printf(" splits=%ld split_iters=%ld at_call_boundary=%ld", s->splits, s->split_iterations, s->splits_at_call);
    if (s->kept_count > 0) {
        printf(" first_offsets=");
        for (int i = 0; i < s->kept_count; i++) printf("%s%ld", i ? "," : "", s->kept[i]);
    }
    printf(" mismatch=%ld broken_markers=%ld stray=%ld", s->a_mismatch, s->broken_markers, s->stray);
}

// variant 0: B is a thread; 1: B is a forked child sharing the slave's open file description.
static void case_interleave(int variant, const Rate *rate, int iterations) {
    int master, slave;
    open_raw_pty(&master, &slave);
    // A second description of the slave, non-blocking, refills the queue quickly.
    int filler = open(ptsname(master), O_WRONLY | O_NOCTTY | O_NONBLOCK);
    if (filler < 0) die("open slave");
    unsigned char fill_block[1024];
    memset(fill_block, FILLER, sizeof fill_block);

    Marker *m = mmap(NULL, sizeof *m, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANON, -1, 0);
    if (m == MAP_FAILED) die("mmap");
    memset(m, 0, sizeof *m);
    m->fd = slave;
    pthread_t b_thread;
    pid_t b_pid = -1;
    if (variant == 0) {
        if (pthread_create(&b_thread, NULL, writer_b_thread, m) != 0) die("pthread_create B");
    } else {
        b_pid = fork();
        if (b_pid < 0) die("fork");
        if (b_pid == 0) {
            for (;;)
                if (write(slave, mark_proc, MARK_LEN) == MARK_LEN) atomic_fetch_add(&m->count, 1);
        }
    }

    Scan s;
    memset(&s, 0, sizeof s);
    long blocked_iters = 0, total_calls = 0, a_failed = 0, lost = 0, b_stuck = 0;
    int64_t a_ns_max = 0;
    int ran = 0;
    for (int it = 0; it < iterations; it++) {
        fill_until_eagain(filler, fill_block, sizeof fill_block);
        if (!wait_b_blocked(m)) {
            b_stuck++;
            break;
        }
        s.a_active = 1;
        s.a_seen = 0;
        s.it_count = 0;
        Ticket t = {.fd = slave};
        pthread_t a;
        if (pthread_create(&a, NULL, writer_a, &t) != 0) die("pthread_create A");
        while (!atomic_load(&t.in_write)) sleep_us(10);
        sleep_us(1000);  // let A enter write(2) and sleep on the full queue
        long steps_while_writing = 0;
        while (!atomic_load(&t.done)) {
            if (drain(master, &s, rate->chunk) > 0 && !atomic_load(&t.done)) steps_while_writing++;
            sleep_us(rate->sleep);
        }
        pthread_join(a, NULL);
        int64_t deadline = now_ns() + 10LL * 1000000000;
        while (s.a_seen < A_LEN && now_ns() < deadline) {
            if (drain(master, &s, 1 << 20) == 0) sleep_us(100);
        }
        if (s.a_seen < A_LEN) lost++;
        count_call_splits(&s, &t);
        s.a_active = 0;
        if (steps_while_writing >= 2) blocked_iters++;
        total_calls += t.calls;
        a_failed += t.failed;
        if (t.ns > a_ns_max) a_ns_max = t.ns;
        ran++;
    }

    if (variant == 0) {
        atomic_store(&m->stop, 1);
        while (!atomic_load(&m->exited)) {
            drain(master, &s, 1 << 20);
            sleep_us(100);
        }
        pthread_join(b_thread, NULL);
    } else {
        kill(b_pid, SIGKILL);
        waitpid(b_pid, NULL, 0);
    }
    close(filler);
    close(slave);
    close(master);
    munmap(m, sizeof *m);

    int exercised = ran == iterations && blocked_iters * 10 >= (long)ran * 9;
    int pass = exercised && s.splits == 0 && s.a_mismatch == 0 && lost == 0 && a_failed == 0;
    printf("%s interleave-%s rate=%s(%ldB/%ldus) iters=%d a_slept=%ld a_calls=%ld a_max_ms=%.1f lost=%ld a_failed=%ld",
           pass ? "PASS" : "FAIL", variant == 0 ? "thread" : "process", rate->name, rate->chunk, rate->sleep, ran,
           blocked_iters, total_calls, a_ns_max / 1e6, lost, a_failed);
    print_scan(&s);
    if (b_stuck) printf(" (B never blocked: queue did not fill)");
    if (!exercised) printf(" (not exercised: A's write did not sleep in >=90%% of iterations)");
    printf("\n");
    fflush(stdout);
}

// ---- Case 2: the writer's EAGAIN path, end to end ----

static void case_writer_nonblock(void) {
    int master, slave;
    open_raw_pty(&master, &slave);
    set_nonblock(slave, 1);
    unsigned char fill_block[1024];
    memset(fill_block, FILLER, sizeof fill_block);
    long filled = fill_until_eagain(slave, fill_block, sizeof fill_block);

    Scan s;
    memset(&s, 0, sizeof s);
    s.a_active = 1;
    Ticket t = {.fd = slave};
    pthread_t a;
    if (pthread_create(&a, NULL, writer_a, &t) != 0) die("pthread_create A");
    while (!atomic_load(&t.done)) {
        drain(master, &s, 512);
        sleep_us(200);
    }
    pthread_join(a, NULL);
    int64_t deadline = now_ns() + 10LL * 1000000000;
    while (s.a_seen < A_LEN && now_ns() < deadline)
        if (drain(master, &s, 1 << 20) == 0) sleep_us(100);
    close(slave);
    close(master);

    int pass = !t.failed && t.polls > 0 && t.poll_bad == 0 && s.a_seen == A_LEN && s.a_mismatch == 0;
    printf("%s writer-loop-nonblock filled=%ld a_calls=%ld polls=%ld poll_bad=%ld a_seen=%ld mismatch=%ld a_ms=%.1f\n",
           pass ? "PASS" : "FAIL", filled, t.calls, t.polls, t.poll_bad, s.a_seen, s.a_mismatch, t.ns / 1e6);
    fflush(stdout);
}

// ---- Case 3: poll and select on a full non-blocking tty ----

typedef struct {
    int master;
    long delay_us;
} Drainer;

static void *drainer(void *arg) {
    Drainer *d = arg;
    sleep_us(d->delay_us);
    unsigned char buf[16384];
    int64_t end = now_ns() + 100LL * 1000000;
    while (now_ns() < end) {
        if (read(d->master, buf, sizeof buf) <= 0) sleep_us(500);
    }
    return NULL;
}

typedef struct {
    pthread_t target;
    atomic_int cancel;
} Watchdog;

static void *watchdog(void *arg) {
    Watchdog *w = arg;
    for (int i = 0; i < 300; i++) {
        if (atomic_load(&w->cancel)) return NULL;
        sleep_us(10000);
    }
    pthread_kill(w->target, SIGUSR1);
    return NULL;
}

static void on_usr1(int sig) { (void)sig; }

static const char *revents_str(short r, char *buf, size_t len) {
    snprintf(buf, len, "%s%s%s%s%s", r & POLLOUT ? "POLLOUT|" : "", r & POLLNVAL ? "POLLNVAL|" : "",
             r & POLLERR ? "POLLERR|" : "", r & POLLHUP ? "POLLHUP|" : "", r & POLLIN ? "POLLIN|" : "");
    size_t n = strlen(buf);
    if (n == 0) snprintf(buf, len, "0");
    else buf[n - 1] = 0;
    return buf;
}

// kind 0: poll(timeout 3000 ms); 1: poll(-1) as the writer, with a 3 s watchdog; 2: select.
static void case_wait(int kind) {
    static const char *names[] = {"poll-timeout", "poll-infinite", "select"};
    const long delay_us = 200000;
    int master, slave;
    open_raw_pty(&master, &slave);
    set_nonblock(slave, 1);
    unsigned char block[1024];
    memset(block, FILLER, sizeof block);
    long filled = fill_until_eagain(slave, block, sizeof block);

    // Ready before anyone drains would make the writer spin on EAGAIN.
    struct pollfd p0 = {.fd = slave, .events = POLLOUT};
    int r0 = poll(&p0, 1, 0);
    fd_set w0;
    FD_ZERO(&w0);
    FD_SET(slave, &w0);
    struct timeval tv0 = {0, 0};
    int s0 = select(slave + 1, NULL, &w0, NULL, &tv0);
    int early = kind == 2 ? s0 : r0;

    Drainer d = {.master = master, .delay_us = delay_us};
    pthread_t dt;
    if (pthread_create(&dt, NULL, drainer, &d) != 0) die("pthread_create drainer");
    Watchdog wd = {.target = pthread_self()};
    pthread_t wt;
    if (kind == 1 && pthread_create(&wt, NULL, watchdog, &wd) != 0) die("pthread_create watchdog");

    int r, err = 0;
    short revents = 0;
    int64_t t0 = now_ns();
    if (kind == 2) {
        fd_set w;
        FD_ZERO(&w);
        FD_SET(slave, &w);
        struct timeval tv = {3, 0};
        r = select(slave + 1, NULL, &w, NULL, &tv);
        if (r < 0) err = errno;
        if (r > 0 && FD_ISSET(slave, &w)) revents = POLLOUT;
    } else {
        struct pollfd p = {.fd = slave, .events = POLLOUT};
        r = poll(&p, 1, kind == 1 ? -1 : 3000);
        if (r < 0) err = errno;
        revents = p.revents;
    }
    double waited_ms = (now_ns() - t0) / 1e6;
    if (kind == 1) {
        atomic_store(&wd.cancel, 1);
        pthread_join(wt, NULL);
    }
    pthread_join(dt, NULL);
    ssize_t after = write(slave, ".", 1);
    int after_errno = after < 0 ? errno : 0;
    close(slave);
    close(master);

    int ok_wait = waited_ms >= delay_us / 1000 * 0.75 && waited_ms < 2900;
    int pass = early == 0 && r == 1 && (revents & POLLOUT) && !(revents & (POLLNVAL | POLLERR | POLLHUP)) && ok_wait &&
               after == 1;
    char rb[64], r0b[64];
    printf("%s %s filled=%ld ready_before_drain: poll=%d(%s) select=%d; returned=%d errno=%s revents=%s waited_ms=%.1f "
           "drain_at_ms=%ld write_after=%zd%s%s\n",
           pass ? "PASS" : "FAIL", names[kind], filled, r0, revents_str(p0.revents, r0b, sizeof r0b), s0, r,
           err ? strerror(err) : "0", revents_str(revents, rb, sizeof rb), waited_ms, delay_us / 1000, after,
           after_errno ? " write_errno=" : "", after_errno ? strerror(after_errno) : "");
    fflush(stdout);
}

int main(int argc, char **argv) {
    int iterations = argc > 1 ? atoi(argv[1]) : 100;
    if (iterations <= 0) iterations = 100;
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_usr1;  // no SA_RESTART: the watchdog interrupts a stuck poll
    sigaction(SIGUSR1, &sa, NULL);
    for (long i = 0; i < A_LEN; i++) a_bytes[i] = (unsigned char)('a' + (i * 7 + i / 26 + i / 677) % 26);

    printf("== os\n");
    fflush(stdout);
    if (system("uname -a") != 0) printf("uname failed\n");
#if defined(__APPLE__)
    if (system("sw_vers") != 0) printf("sw_vers failed\n");
#endif
    printf("== probe ticket=%d marker=%d a_chunk=%d iterations=%d\n", A_LEN, MARK_LEN, PROBE_A_CHUNK, iterations);
    fflush(stdout);

    for (int variant = 0; variant < 2; variant++)
        for (size_t r = 0; r < sizeof rates / sizeof rates[0]; r++) case_interleave(variant, &rates[r], iterations);
    case_writer_nonblock();
    for (int kind = 0; kind < 3; kind++) case_wait(kind);
    return 0;
}
