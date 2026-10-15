#include "NodeStarter.h"
#include <NodeMobile/NodeMobile.h>
#include <stdlib.h>
#include <string.h>

int kr_node_start(const char *script) {
    // Node erwartet argv in einem zusammenhängenden Speicherblock (libuv überschreibt ihn für den Prozesstitel).
    const char *args[] = { "node", script };
    const int argc = 2;
    size_t total = 0;
    for (int i = 0; i < argc; i++) total += strlen(args[i]) + 1;
    char *buf = calloc(total, 1);
    char *argv[argc + 1];
    char *p = buf;
    for (int i = 0; i < argc; i++) {
        size_t n = strlen(args[i]) + 1;
        memcpy(p, args[i], n);
        argv[i] = p;
        p += n;
    }
    argv[argc] = NULL;
    return node_start(argc, argv);
}
