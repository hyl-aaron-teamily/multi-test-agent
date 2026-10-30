package ai.autotest.a11y;

/** In-memory only: a restarted service answers 401 until the host sends a new token. */
final class TokenStore {
    private static volatile String token;

    private TokenStore() {
    }

    static String get() {
        return token;
    }

    static void set(String t) {
        token = t;
    }
}
