// Startet Node (nodejs-mobile) im Prozess der App und leitet stdout/stderr ins Logcat (Tag "node").
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "node.h"

static int pipeFds[2];

static void *logThread(void *) {
    char buf[2048];
    ssize_t n;
    while ((n = read(pipeFds[0], buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') n--;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, "node", buf);
    }
    return nullptr;
}

static void redirectOutput() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipeFds);
    dup2(pipeFds[1], STDOUT_FILENO);
    dup2(pipeFds[1], STDERR_FILENO);
    pthread_t t;
    if (pthread_create(&t, nullptr, logThread, nullptr) == 0) pthread_detach(t);
}

extern "C" JNIEXPORT jint JNICALL
Java_de_sgitaize_letzterunde_NodeHost_startNode(JNIEnv *env, jobject, jstring script, jobjectArray envVars) {
    // Umgebung (KEY=VALUE) vor dem Start setzen
    for (jsize i = 0; i < env->GetArrayLength(envVars); i++) {
        auto s = (jstring) env->GetObjectArrayElement(envVars, i);
        const char *kv = env->GetStringUTFChars(s, nullptr);
        std::string pair(kv);
        env->ReleaseStringUTFChars(s, kv);
        auto eq = pair.find('=');
        if (eq != std::string::npos) setenv(pair.substr(0, eq).c_str(), pair.substr(eq + 1).c_str(), 1);
    }
    const char *path = env->GetStringUTFChars(script, nullptr);
    std::vector<std::string> args = {"node", path};
    env->ReleaseStringUTFChars(script, path);

    // argv muss zusammenhängend im Speicher liegen (libuv)
    size_t total = 0;
    for (auto &a : args) total += a.size() + 1;
    char *block = (char *) calloc(total, 1);
    std::vector<char *> argv;
    char *p = block;
    for (auto &a : args) { memcpy(p, a.c_str(), a.size() + 1); argv.push_back(p); p += a.size() + 1; }
    argv.push_back(nullptr);

    redirectOutput();
    return jint(node::Start(int(args.size()), argv.data()));
}
