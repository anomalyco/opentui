#define _DEFAULT_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

/* Example-only terminal transport. OpenTUI's C ABI renders the UI. */
static struct termios saved;
static const int signals[] = {SIGINT, SIGTERM, SIGHUP};
static struct sigaction previous[3];
static unsigned installed;
static int active;
static int output_flags;
static volatile sig_atomic_t stopping;

static void stop(int signal_number) {
    (void)signal_number;
    stopping = 1;
}

int rust_terminal_close(void) {
    int result = 0;
    if (active) {
        do {
            result = tcsetattr(STDIN_FILENO, TCSANOW, &saved);
        } while (result < 0 && errno == EINTR);
        if (fcntl(STDOUT_FILENO, F_SETFL, output_flags) < 0) result = -1;
        active = 0;
    }
    while (installed > 0) {
        --installed;
        if (sigaction(signals[installed], &previous[installed], NULL) < 0) result = -1;
    }
    return result;
}

int rust_terminal_open(void) {
    if (!isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO)) {
        errno = ENOTTY;
        return -1;
    }
    if (tcgetattr(STDIN_FILENO, &saved) < 0) return -1;
    output_flags = fcntl(STDOUT_FILENO, F_GETFL);
    if (output_flags < 0) return -1;
    stopping = 0;
    struct sigaction action = {.sa_handler = stop};
    sigemptyset(&action.sa_mask);
    for (; installed < 3; ++installed) {
        if (sigaction(signals[installed], &action, &previous[installed]) < 0) goto fail;
    }
    struct termios raw = saved;
    cfmakeraw(&raw);
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) < 0) goto fail;
    active = 1;
    if (fcntl(STDOUT_FILENO, F_SETFL, output_flags | O_NONBLOCK) < 0) goto fail;
    return 0;
fail: {
    int error = errno;
    rust_terminal_close();
    errno = error;
    return -1;
}
}

int rust_terminal_size(uint32_t *width, uint32_t *height) {
    struct winsize size;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &size) < 0) return -1;
    *width = size.ws_col ? size.ws_col : 80;
    *height = size.ws_row ? size.ws_row : 24;
    return 0;
}

/* -2 means hangup or a shutdown signal; zero is a timeout, not EOF. */
int rust_terminal_read(uint8_t *bytes, uint32_t capacity, int32_t timeout_ms) {
    if (timeout_ms < 0 || timeout_ms > 1000) {
        errno = EINVAL;
        return -1;
    }
    if (stopping) return -2;
    struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
    int ready = poll(&input, 1, timeout_ms);
    if (stopping) return -2;
    if (ready < 0) return errno == EINTR ? 0 : -1;
    if (ready == 0) return 0;
    if (input.revents & (POLLERR | POLLHUP | POLLNVAL)) return -2;
    ssize_t count = read(STDIN_FILENO, bytes, capacity);
    if (count < 0) return errno == EINTR ? 0 : -1;
    return count == 0 ? -2 : (int)count;
}

/* An unread PTY must not prevent shutdown or leave the local terminal in raw mode. */
int rust_terminal_write(const uint8_t *bytes, uint32_t count) {
    ssize_t written = write(STDOUT_FILENO, bytes, count);
    if (written >= 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) return (int)written;
    if (stopping) {
        errno = ECANCELED;
        return -1;
    }
    struct pollfd output = {.fd = STDOUT_FILENO, .events = POLLOUT};
    int ready = poll(&output, 1, 1000);
    if (ready <= 0) {
        if (ready == 0) errno = ETIMEDOUT;
        else if (errno == EINTR && stopping) errno = ECANCELED;
        return -1;
    }
    return (int)write(STDOUT_FILENO, bytes, count);
}

/* Diagnostics must not block exit when stderr shares the stalled terminal. */
void rust_terminal_report_error(const uint8_t *bytes, uint32_t count) {
    int flags = fcntl(STDERR_FILENO, F_GETFL);
    if (flags < 0 || fcntl(STDERR_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) return;
    (void)write(STDERR_FILENO, bytes, count);
    (void)fcntl(STDERR_FILENO, F_SETFL, flags);
}
