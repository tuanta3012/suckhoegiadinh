package com.suckhoegiadinh.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.FileUtils;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "DocumentScanner")
public class DocumentScannerPlugin extends Plugin {

    private static final String TAG = "DocumentScannerPlugin";
    private static final String PREFS_NAME = "stk_doc_scanner_prefs";
    private static final String KEY_PENDING_MODE = "pending_mode";

    private ActivityResultLauncher<IntentSenderRequest> scannerLauncher;
    private String pendingCallId;
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        scannerLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::handleScanActivityResult
        );
    }

    @Override
    protected void handleOnDestroy() {
        ioExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void scan(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }
        if (scannerLauncher == null) {
            call.reject("MLKIT_UNAVAILABLE: Document scanner launcher is not initialized.");
            return;
        }

        String requestedMode = call.getString("mode", "single");
        boolean isMulti = "multi".equalsIgnoreCase(requestedMode);
        String normalizedMode = isMulti ? "multi" : "single";
        Integer limitArg = call.getInt("pageLimit");
        int pageLimit = isMulti
            ? Math.max(2, limitArg != null ? limitArg : 20)
            : 1;
        boolean allowGalleryImport = Boolean.TRUE.equals(call.getBoolean("allowGalleryImport", false));

        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(allowGalleryImport)
            .setPageLimit(pageLimit)
            .setResultFormats(
                GmsDocumentScannerOptions.RESULT_FORMAT_JPEG,
                GmsDocumentScannerOptions.RESULT_FORMAT_PDF
            )
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();

        savePendingMode(normalizedMode);
        pendingCallId = call.getCallbackId();
        bridge.saveCall(call);

        try {
            GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
            scanner
                .getStartScanIntent(activity)
                .addOnSuccessListener(
                    activity,
                    intentSender -> {
                        try {
                            IntentSenderRequest request = new IntentSenderRequest.Builder(intentSender).build();
                            scannerLauncher.launch(request);
                        } catch (Exception ex) {
                            releasePendingCall(call);
                            clearPendingMode();
                            call.reject("MLKIT_UNAVAILABLE: " + ex.getMessage(), ex);
                        }
                    }
                )
                .addOnFailureListener(
                    activity,
                    ex -> {
                        releasePendingCall(call);
                        clearPendingMode();
                        call.reject("MLKIT_UNAVAILABLE: " + ex.getMessage(), ex);
                    }
                );
        } catch (Exception ex) {
            releasePendingCall(call);
            clearPendingMode();
            call.reject("MLKIT_UNAVAILABLE: " + ex.getMessage(), ex);
        }
    }

    private void handleScanActivityResult(ActivityResult result) {
        PluginCall savedCall = pendingCallId != null ? bridge.getSavedCall(pendingCallId) : null;
        pendingCallId = null;
        String resolvedMode = consumePendingMode();

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            if (savedCall != null) {
                bridge.releaseCall(savedCall);
                savedCall.reject("User cancelled document scan");
            }
            return;
        }

        GmsDocumentScanningResult scanningResult = GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
        if (scanningResult == null) {
            if (savedCall != null) {
                bridge.releaseCall(savedCall);
                savedCall.reject("Không đọc được kết quả quét tài liệu.");
            }
            return;
        }

        ioExecutor.execute(() -> {
            try {
                JSObject payload = buildResultPayload(scanningResult, resolvedMode);
                if (savedCall != null) {
                    bridge.releaseCall(savedCall);
                    savedCall.resolve(payload);
                } else {
                    notifyListeners("scanRestored", payload, true);
                }
            } catch (Exception ex) {
                Log.e(TAG, "Failed to process scanned document files", ex);
                if (savedCall != null) {
                    bridge.releaseCall(savedCall);
                    savedCall.reject("Không thể đọc tệp tài liệu sau khi quét: " + ex.getMessage(), ex);
                }
            }
        });
    }

    private JSObject buildResultPayload(GmsDocumentScanningResult scanningResult, String mode) throws IOException {
        Context context = getContext();
        String localUrl = bridge.getLocalUrl();
        long stamp = System.currentTimeMillis();

        JSObject ret = new JSObject();
        ret.put("mode", mode);

        JSArray pagesArray = new JSArray();
        List<GmsDocumentScanningResult.Page> pages = scanningResult.getPages();
        if (pages != null) {
            int idx = 1;
            for (GmsDocumentScanningResult.Page page : pages) {
                Uri sourceUri = page.getImageUri();
                if (sourceUri == null) continue;
                File cachedImage = copyUriToCache(context, sourceUri, "mlkit_page_" + stamp + "_" + idx + ".jpg");
                Uri cachedUri = Uri.fromFile(cachedImage);
                JSObject pageObj = new JSObject();
                pageObj.put("path", cachedUri.toString());
                pageObj.put("webPath", FileUtils.getPortablePath(context, localUrl, cachedUri));
                pageObj.put("format", "jpeg");
                pagesArray.put(pageObj);
                idx++;
            }
        }
        ret.put("pages", pagesArray);

        GmsDocumentScanningResult.Pdf pdf = scanningResult.getPdf();
        if (pdf != null && pdf.getUri() != null) {
            File cachedPdf = copyUriToCache(context, pdf.getUri(), "mlkit_doc_" + stamp + ".pdf");
            Uri cachedPdfUri = Uri.fromFile(cachedPdf);
            JSObject pdfObj = new JSObject();
            pdfObj.put("path", cachedPdfUri.toString());
            pdfObj.put("webPath", FileUtils.getPortablePath(context, localUrl, cachedPdfUri));
            pdfObj.put("pageCount", pdf.getPageCount());
            ret.put("pdf", pdfObj);
        }

        return ret;
    }

    private File copyUriToCache(Context context, Uri sourceUri, String fileName) throws IOException {
        File cacheDir = new File(context.getCacheDir(), "mlkit_scans");
        if (!cacheDir.exists() && !cacheDir.mkdirs()) {
            throw new IOException("Cannot create cache directory");
        }
        File targetFile = new File(cacheDir, fileName);
        try (InputStream in = context.getContentResolver().openInputStream(sourceUri);
             FileOutputStream out = new FileOutputStream(targetFile)) {
            if (in == null) {
                throw new IOException("Cannot open scanned file URI: " + sourceUri);
            }
            byte[] buffer = new byte[16384];
            int bytesRead;
            while ((bytesRead = in.read(buffer)) != -1) {
                out.write(buffer, 0, bytesRead);
            }
            out.flush();
        }
        return targetFile;
    }

    private void releasePendingCall(PluginCall call) {
        if (call != null) {
            bridge.releaseCall(call);
        }
        pendingCallId = null;
    }

    private void savePendingMode(String mode) {
        Context context = getContext();
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_PENDING_MODE, mode).apply();
    }

    private String consumePendingMode() {
        Context context = getContext();
        if (context == null) return "single";
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String mode = prefs.getString(KEY_PENDING_MODE, "single");
        prefs.edit().remove(KEY_PENDING_MODE).apply();
        return "multi".equalsIgnoreCase(mode) ? "multi" : "single";
    }

    private void clearPendingMode() {
        Context context = getContext();
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().remove(KEY_PENDING_MODE).apply();
    }
}
