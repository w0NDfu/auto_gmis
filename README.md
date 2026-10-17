# auto_gmis · GMIS 报名助手

面向 GMIS 的 Chrome 扩展及本机后台，支持劳动实践、学术报告、关键词匹配、定时尝试、多账号独立会话和报名结果核验。

## 安装使用（Windows）

1. 安装 Google Chrome 和 Node.js 20 或更高版本。
2. 下载本仓库 ZIP 并解压，或使用 `git clone https://github.com/w0NDfu/auto_gmis.git`。
3. 在 Chrome 打开 `chrome://extensions`，开启开发者模式，点击「加载已解压的扩展程序」，选择本项目的 `gmis-extension` 文件夹（包含 `manifest.json`）。
4. 双击 `gmis-helper/start-helper.cmd`。首次启动需要联网安装锁定版本的 Playwright Core；后台使用本机 Chrome，不下载额外浏览器。
5. 点击扩展图标，在控制台粘贴后台窗口中的配对码并连接。
6. 在「自动登录设置」选择默认的「统一身份认证（校园门户）」，填写自己的学号和统一认证密码，添加账号。
7. 选择类别、输入项目名称的一部分并获取项目列表，为各账号选定目标，再设置时间和重试参数并启动。

运行期间保持后台窗口与扩展控制台开启。无需 Python 即可使用；Python 仅用于开发时重新生成分发包。

## 功能与参数

- 同一控制台管理多个账号，后台为各账号创建独立的内存浏览器会话。
- 登录路径：统一身份认证 → 校园门户 → 研究生系统 → GMIS 主页实际学号核验。
- 类别：劳动实践、学术报告。项目名称支持部分匹配，多个关键词用空格分隔。
- 开始尝试时间留空时，按项目的**报名开始时间提前 1 分钟**开始；也可填写北京时间。活动举办时间与报名开始时间不同。
- 失败后重试间隔为 0.01–60 秒，每账号最多尝试次数为 1–99999，默认 90。
- 0.01 秒指失败后的等待，网络请求、识别和结果核验另需耗时，不保证每秒提交 100 次。
- 数字图形验证码使用随扩展打包的本地 Tesseract OCR；滑块、短信及其他二次验证可能需要人工处理。
- 只有在学校的成功报名列表核验通过后才报告成功；提交结果不明确时停止盲目重发。

## 会话与数据

账号密码、Cookie、配对码和任务状态保存在内存。退出后台后需重新添加账号。后台仅监听本机 `127.0.0.1:8767`，使用每次启动生成的配对码认证。

请使用自己的账号并遵守学校报名规则。项目不保证抢到名额；学校页面或接口变化可能影响运行。

## 目录

```text
gmis-extension/   Chrome 扩展、OCR 资源、前端测试与打包脚本
gmis-helper/      本机多账号后台、启动脚本与模拟测试
```

详细说明：[扩展 README](gmis-extension/README.md)、[后台 README](gmis-helper/README.md)、[多账号说明](gmis-extension/MULTI_ACCOUNT.md)。第三方资源及许可证见 [THIRD_PARTY_NOTICES.md](gmis-extension/THIRD_PARTY_NOTICES.md)。

## 开发验证

```powershell
cd gmis-extension
npm test
cd ../gmis-helper
npm ci --ignore-scripts
npm test
```

模拟测试不会填写真实凭据或实际报名。统一认证表单识别和 GMIS 学号读取已在真实页面进行只读验证，完整流程仍需自行验证。

重新打包（Python 3.10+）：

```powershell
python gmis-extension/package_extension.py
python gmis-helper/package_helper.py
```

两个 ZIP 会输出到仓库根目录。对外分发时需要同时提供扩展和后台。
