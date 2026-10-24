# 测试说明

zuocai 的自动测试使用内存 SQLite 和模拟的 Capacitor 原生接口，不会读取真实手机数据。

```powershell
pnpm run test
pnpm run check
pnpm run build
```

测试覆盖备份校验、待办和日程、时间负荷、训练计划、训练组、休息计时、前台恢复、通知模型、CSV 导出和异常回滚。

自动测试不能代替目标设备上的通知、系统杀进程恢复、系统备份、分享面板和覆盖升级验收。