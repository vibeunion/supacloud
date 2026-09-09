# Command 架构收敛验收

目标：让消费者复用可靠的命令执行协议，不因迁移而被迫接受浏览器状态管理、
数据库实现或空壳 Controller。保留单次写入、幂等与未知结果保护。

本轮不做客户迁移、生产部署、npm 发布，也不新增队列或调度器。

逻辑依赖：

- contracts 根入口：协议、解码、错误；`/client` 与 `/browser` 显式选择。
- commands：依赖协议与抽象存储，不依赖数据库、Svelte、HTTP。
- db：PostgreSQL 存储、提交身份绑定、事务内入队及输入保留。
- elysia：依赖统一命令接口与错误；通过现有 Job 执行恢复批次。
- app-svelte：可选的目标失效与卸载绑定，不自动清持久锁。

```gherkin
Scenario: 授权基础设施不可用
  Given 授权函数发生连接故障
  When 执行命令
  Then 返回基础设施不可用而不是权限拒绝
  And 不执行业务写入

Scenario: 页面组件复用
  Given 原请求仍在等待
  When 同一组件切换业务目标或主动失效
  Then 原请求取消且迟到结果不能提交
  And 原持久锁仍可按原操作编号恢复

Scenario: 恢复进程重启
  Given 外部操作已确认但审计未完成
  When 现有 Workflow 重新投递恢复步骤
  Then 仅补审计且保留原操作人
  And 原 Workflow attempt 控制步骤确认，事务锁保护业务回执

Scenario: 数据保留期到达
  Given 已确认且审计完成的操作超过输入保留期
  When 保留任务清除输入快照
  Then 幂等指纹和回执仍存在
  And 未完成操作的输入不被清除

Scenario: 真实编译生成物
  Given 一个包含业务 Command 与路由的模块源码
  When 编译后加载生成物并发出 HTTP 请求
  Then 业务只在命令事务里执行一次
  And 不依赖手写 CompiledModule 或抛错占位方法
```
