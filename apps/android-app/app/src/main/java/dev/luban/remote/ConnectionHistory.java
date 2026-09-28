package dev.luban.remote;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Recent console links. The encrypted value can contain access tokens; labels never do. */
final class ConnectionHistory {
    static final class Record {
        final String launchUrl;
        final String displayUrl;

        Record(String launchUrl, String displayUrl) {
            this.launchUrl = launchUrl;
            this.displayUrl = displayUrl;
        }
    }

    private static final String PREF_HISTORY = "recent_connections_v1";
    private static final String KEY_ALIAS = "luban_recent_connections_v1";
    private static final int MAX_RECORDS = 12;
    private final SharedPreferences preferences;

    ConnectionHistory(SharedPreferences preferences) { this.preferences = preferences; }

    List<Record> load() {
        List<Record> records = new ArrayList<>();
        String stored = preferences.getString(PREF_HISTORY, "");
        if (stored == null || stored.isEmpty()) return records;
        try {
            JSONArray array = new JSONArray(decrypt(stored));
            for (int index = 0; index < array.length() && records.size() < MAX_RECORDS; index++) {
                JSONObject item = array.getJSONObject(index);
                String launch = item.optString("launch", "");
                String display = item.optString("display", "");
                if (!launch.isEmpty() && !display.isEmpty()) records.add(new Record(launch, display));
            }
        } catch (Exception ignored) {
            // A restored preference without its device-bound key cannot be decrypted.
            records.clear();
        }
        return records;
    }

    boolean remember(String launchUrl, String displayUrl) {
        List<Record> records = load();
        records.removeIf(item -> item.displayUrl.equals(displayUrl));
        records.add(0, new Record(launchUrl, displayUrl));
        while (records.size() > MAX_RECORDS) records.remove(records.size() - 1);
        return save(records);
    }

    boolean forget(String displayUrl) {
        List<Record> records = load();
        records.removeIf(item -> item.displayUrl.equals(displayUrl));
        return save(records);
    }

    private boolean save(List<Record> records) {
        try {
            JSONArray array = new JSONArray();
            for (Record item : records) {
                JSONObject value = new JSONObject();
                value.put("launch", item.launchUrl);
                value.put("display", item.displayUrl);
                array.put(value);
            }
            preferences.edit().putString(PREF_HISTORY, encrypt(array.toString())).apply();
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry existing = store.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }

    private static String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
                + Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    }

    private static String decrypt(String value) throws Exception {
        int separator = value.indexOf(':');
        if (separator <= 0) throw new IllegalArgumentException("invalid encrypted history");
        byte[] nonce = Base64.decode(value.substring(0, separator), Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(value.substring(separator + 1), Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, nonce));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }
}
