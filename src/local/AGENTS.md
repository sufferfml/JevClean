# 本地运行模块

仅用于用户本机，不是可公开部署的多用户服务器。调用核心 `MailService`，向浏览器提供具名 HTTP API；参见 [架构说明](../../docs/architecture.md)。

- `main.ts`：数据目录、单实例、启动浏览器、停止与退出；只有这里读取启动环境变量。macOS AppKit 启动器提供菜单栏图标及系统再次打开事件，复用这里的服务并记录 `service.reopened`。菜单栏只读取已验证的本地 instance 与精简 runtime；同意项或邮箱密钥不会写入菜单栏日志。首次 `--no-open` 不限制用户之后主动打开。
- `server.ts`：127.0.0.1、随机令牌、Host／Origin、参数与请求体限制、静态文件边界、统一安全错误；bootstrap 提供最近操作汇总、当前进度及核心模块的本次连接验证状态与最近动作预检。`check-actions` 只读检查启用动作的配置、文件夹及协议能力，并更新语义摘要匹配的报告的执行状态，不调用 Jev 或修改邮箱。shutdown 经身份／参数及空闲状态验证后通知 main 结束服务，不能中断执行／撤销任务。菜单栏重启先走同一空闲关闭接口，再启动新进程；不杀进程绕过任务锁。`runtime` 只返回任务阶段、数量、真实互斥状态与界面语言，不返回账号、邮件或密钥；`analysis-settings` 只接受分析区偏好，合并到现有加密设置。`read-mail` 提供独立只读列表能力，当前 UI 不暴露此入口；`manual-check` 检查用户指定动作并返回确认计划，`manual-execute` 只接受该计划标识，不接受模型证据或任意命令；`action-folders` 仅保存系统目标映射，不提交设置草稿。`execute` 执行已保存的规则动作，`resolve-conflict` 只能选择已验证的匹配选项，`refresh-actions` 只查询最近批次的位置／标记；不保留旧 `move`／`refresh-cleanup` HTTP 别名。
- `cipher.ts`：AES-256-GCM 与系统凭据库。Linux 明确选 Secret Service；禁止内存／明文降级。
- `logger.ts`：允许列表内的汇总数字和应用事件，文件轮换；日志失败不能改变邮箱操作结果。核心操作诊断经回调接入相同日志；`reasonCode` 只接受固定枚举，`durationMs` 只接受非负有限数字，另记处理／撤销计数。区分自动核对启动、完成、读取失败和最终未确认原因，不包含记录 ID、账号、主题、文件夹或协议原文。

诊断仍走相同Host／Origin／会话令牌边界：`analysis-trace` 验证当前报告及记录标识后只读本地加密trace；`clear-analysis-traces` 只清完整调用记录，不清基本判断及撤销；`retry-analysis` 接收报告、邮件ID和明确发送同意，由核心复核原输入／同账号规则范围／7天时限及失败资格，不接受任意请求体、URL或模型答案。服务启动／公开配置访问及trace访问触发到期清理，应用关闭期间到期在下次启动处理。诊断原始请求／响应及密钥不进入operation日志；已知用量与失败分类保存在加密分析证据中。

不能添加任意 URL 请求、任意路径读写或直接渲染邮件 HTML。HTTP 和加密变更要核对 `tests/server.test.ts`／`tests/cipher.test.ts`；生产包另用临时目录验证，不能读取用户已有配置。
