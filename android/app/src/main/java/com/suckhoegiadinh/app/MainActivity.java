package com.suckhoegiadinh.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DocumentScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
