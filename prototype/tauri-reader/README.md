# Paper30min PROTOTYPE（一次性原型，issue #20）

验证 Tauri Windows + Android 能否承载现有 Web 阅读器。**不是正式实现，不合入主线。**
验证矩阵与通过标准见 `docs/draft/prototypes/2026-09-05-tauri-client-validation.md`。

## 运行

```bash
# 1. 启动模拟服务（SSE 流式 / 双版本内容 / 示例 PDF）
python prototype/tauri-reader/mock_server.py

# 2. 开发模式
cd prototype/tauri-reader && npm run tauri dev

# 3. Windows 安装包
cd prototype/tauri-reader && npm run tauri build
# 产物: src-tauri/target/release/bundle/nsis/*-setup.exe

# 4. Android（先连接手机并 adb reverse）
adb reverse tcp:8791 tcp:8791
cd prototype/tauri-reader && npm run tauri android build -- --apk
# 产物: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
# 或 debug: src-tauri/gen/android/app/build/outputs/apk/*/debug/*.apk
adb install -r <apk>
```

## 隔离

- 应用标识 `com.paper30min.prototype`，数据目录独立（Tauri app_data_dir 下 `prototype.sqlite` + `attachments/`）。
- Android 测试签名使用本机 debug keystore（`~/.android/debug.keystore`），覆盖安装用同一签名。
- 仅使用示例论文与模拟服务，不含真实书库数据或 API Key。
