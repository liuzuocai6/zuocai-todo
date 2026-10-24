# zuocai-todo 维护指南

这份指南面向仓库维护者。项目当前只展示 `zuocai` Android App，仓库中的源码、截图和安装包都应围绕这个 App 维护。

## 日常更新流程

1. 在本地修改代码或文档。
2. 运行测试和检查：

   ```powershell
   pnpm run test
   pnpm run check
   pnpm run build
   ```

3. 检查 `git status`，确认没有出现数据库、JSON 备份、签名文件、`.local/`、`.venv/`、`node_modules/` 或 Android 构建目录。
4. 写清楚提交信息并推送到 `main`，或者先创建分支和 Pull Request。

## 更新截图

README 使用固定文件名引用 `docs/screenshots/` 中的图片。要替换预览图时，保持下面 5 个文件名不变即可：

- `01-today.png`：今日
- `02-schedule.png`：日程
- `03-goals.png`：长期目标
- `04-fitness.png`：健身
- `05-settings.png`：设置

截图上传前请确认没有姓名、手机号、账号、通知内容、真实任务、备份数据或电脑路径。公开预览最好使用演示数据。

## 更新 APK

1. 修改 `package.json` 和 Android 工程中的版本号、版本代码。
2. 使用发布签名构建 APK，并在真实 Android 设备上安装验证。
3. 将最终 APK 放入 `releases/`，同时生成同名 `.sha256` 校验文件。
4. 更新 README 的版本说明和 `releases/README.md`。
5. 推送源码和 APK 后，再在 GitHub 的 Releases 页面创建对应版本标签，例如 `v1.4.3`。

不要提交签名密钥、密钥密码、真实数据库或用户备份。升级已有安装时必须继续使用相同签名。

## GitHub 项目维护

- **Issues**：用来记录 bug 和功能建议；标题写清楚现象，正文附设备型号、Android 版本、App 版本和复现步骤，不要附隐私数据。
- **Labels**：建议使用 `bug`、`enhancement`、`documentation`、`release` 和 `privacy`。
- **Pull Requests**：每个改动尽量单独提交，说明改了什么、如何验证、是否影响数据迁移或 APK 升级。
- **Releases**：源码提交和 APK 发布可以放在同一个版本号下；发布说明写出主要变化、已知限制和 SHA-256。
- **仓库可见性**：在确认 README、截图、APK 和提交历史没有私人内容后，再把仓库从 Private 改为 Public。

## 发布前检查

- [ ] `pnpm run test` 全部通过
- [ ] `pnpm run check` 通过
- [ ] `pnpm run build` 通过
- [ ] APK 可以安装并启动
- [ ] APK 包名、版本号、签名和 SHA-256 已核对
- [ ] README 截图链接可以打开
- [ ] 没有个人路径、数据库、备份、密钥或账号信息
