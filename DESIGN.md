---
name: JevClean
description: PreVibe 客户端风格的本地邮件整理工作区
colors:
  ground: "#edf1f5"
  surface: "#f7f9fc"
  surface-muted: "#e8edf3"
  text: "#1f2937"
  muted: "#596579"
  line: "#cbd3dd"
  control-line: "#a7b2c0"
  hover: "rgba(96,112,131,.14)"
  active: "rgba(96,112,131,.24)"
  accent: "#424a57"
  accent-hover: "#303a49"
  focus: "#2866b4"
  tint: "#e7edf5"
  success: "#266247"
  success-bg: "#e5f0e9"
  warning: "#825711"
  warning-bg: "#fff3db"
  danger: "#9c392f"
  danger-bg: "#faeae6"
typography:
  headline:
    fontFamily: "'Inter', 'SF Pro Display', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.85rem"
    fontWeight: 650
    lineHeight: 1.3
  section:
    fontFamily: "'Inter', 'SF Pro Display', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "'Inter', 'SF Pro Display', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.07rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "'Inter', 'SF Pro Display', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  reading:
    fontFamily: "'Inter', 'SF Pro Display', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.14rem"
    fontWeight: 400
    lineHeight: 1.85
  hint:
    fontFamily: "'Inter', 'SF Pro Display', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: ".86rem"
    fontWeight: 400
    lineHeight: 1.65
  badge:
    fontFamily: "'Inter', 'SF Pro Display', 'PingFang SC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: ".8rem"
    fontWeight: 550
    lineHeight: 1.5
rounded:
  control: "10px"
  row: "8px"
  button: "12px"
  settings: "22px"
  badge: "5px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  row: "20px"
  section: "24px"
  wide: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
  selection-bar:
    backgroundColor: "#e8eef5"
  operation-band:
    backgroundColor: "{colors.ground}"
  mail-row:
    backgroundColor: "{colors.surface}"
---

# JevClean 设计规范

2026-10-06 视觉基线；2026-10-07 根据用户截图继续精简标题、辅助信息与确认方式。各轮验证分别记录，见下文。用户明确指定模仿 PreVibe 客户端当前默认浅色；旧 Apple-like／绿色方案 B 已被这一方向替代。依据是 PreVibe `src/App.css` 最终覆盖区（约 8379 行起）及真实客户端截图，详见[方案与实施记录](docs/product-design-review-2026-10-06.md)。不复制参考项目业务、Logo、原生交通灯或技术栈。

YAML 记录原始 token，`.impeccable/design.json` 补充语义、交互及可运行片段。最终实现以 [styles.css](src/renderer/styles.css)、[界面模块](src/renderer/AGENTS.md) 为准；[PRODUCT.md](PRODUCT.md) 记录产品与安全边界。所有字体、图标、静态资源来自本机或打包文件，不请求远程资源。

## 视觉原则

连续的平面工作区、细分隔、低饱和灰蓝面和深灰主按钮。邮件及用户决策占主要位置，不用层叠卡片、营销插画或大面积绿色面板。品牌标记保留原有绿色；正文用深灰，次级文字加深到 `#596579` 以保持对比。文字与颜色共同表达状态。

主色用于「开始分析」「整理」与最终确认的主次层级，红色只表达删除判断或失败，琥珀色表达需判断或待核对，完成色只属于真实操作结果。**手动操作完成不能把“需要确认”的 AI 标签变绿。** 概率不是准确率，不作成功状态展示。

## 构图与密度

- 顶栏最小 48px，品牌、邮箱状态、应用菜单与设置；运行及退出在应用菜单，忙碌时不能退出。
- 桌面侧栏 320px，包含文件夹、范围、全部规则及发送许可；侧栏内容独立滚动，底部常驻「开始分析」。侧栏和规则列表常驻，文件夹／邮件范围／过滤规则使用同字体字号的分组标题，移除「分析设置」「本次范围」两层冗余标题；逐条描述默认收起，通过条内「展开／收起」控制。过滤规则区只显示「管理规则」入口，新增入口位于管理页。
- 右侧邮件区独立滚动，顶部常驻八个手动动作及「整理」。规则与范围变化不挤走固定分析按钮，右侧滚动不改变左侧位置。
- 1100px 及以下侧栏为 240px，工作区保留至少 760px 宽度，可横向访问；不切换为折叠或上下布局。1200px 以下发件人合入主题副行；760px 以下邮件行按主题、位置、判断、结果重排。
- 邮件行平面分隔，主题最多两行，完整内容可阅读；宽列表六列：勾选、主题、发件人、日期／文件夹、AI 判断、处理结果。选择命中区 44px，复选框本体 18px。
- 设置内容最大 960px，22px 外轮廓；窄窗口 16px 外轮廓并重排表单。导航依次为「分析服务」「邮箱设置」「显示语言」「管理规则」「隐私记录」，默认「分析服务」；API、邮箱、语言各自独立成页。跨页共享配置与密钥草稿，保存和返回邮件保留原有语义，不新增路由。规则完整描述常显，新规则表单在顶部，新增规则置顶。

根字号 14px，普通文字 1rem，邮件主题约 15px、阅读正文约16px，元数据约12px。主要尺寸采用 rem，中文不人为加字符间距；窄窗和文字放大允许顶栏换行，不裁掉设置入口。

## 范围、选择与阅读

范围摘要表示下一次分析的配置。列表分析元信息只保留分析时间和 token 累计，不再展示快照、范围详情或重复操作说明。「开始分析」始终调用 scan，在内部读取配置范围并按规则分析，不按复选框集合分析。界面无独立读取邮件入口；分析不修改邮箱。每次分析可能重新消耗额度，token 累计仅包含获得有效判断的响应，口径提示不能反映所有失败与中间重试的消耗，不等同完整账单。

结果标题为「邮件」，固定四类「符合规则／待查看／暂不整理／全部邮件」。符合规则分类不因执行状态消失；未分类并入待查看；暂不整理包括独立全局保留或全部普通规则明确不匹配，行内显示实际理由，不能把单条规则的例外当作全局保留。AI 判断、执行准备与真实处理结果独立展示。

有效结果加载、分析完成或回到命中页时默认勾选可执行命中邮件，用户可取消。切换其他分类清除选择及搜索。本地搜索只匹配当前内存的主题与发件人；搜索变化取消不匹配邮件的勾选，清空搜索不补选。工具栏保留已选数量，移除查看已选、清除选择和筛选外已选计数。

正文在列表下方独立阅读区展示纯文本，打开阅读不改变选择。Escape／关闭返回触发邮件和右侧滚动位置。键盘焦点进入内部详情时自动避开顶部工具栏。行内「分析详情」另展示本地历史规则、条件／时间原始选项和完整概率、程序结论及逐次调用，不依赖正文读取或邮箱连接。缺失历史证据明确说明，不用当前输入重建；模型判断和程序拦截原因分开显示。

版本8普通规则的例外只约束本条，独立保留动作才全局保护；低把握的全局保护进入需确认，普通不确定不否决另一完整匹配。旧设置在管理规则确认语义，不能用确认按钮把旧报告升级为可执行。详情中不能将“本条已排除”展示成“全局保留”。新三选项提示及本轮诊断／重试能力已实现，最终集成和安装证据待本轮单独记录，真实模型质量未验证。

基本证据无正文上下文；完整调用记录须在隐私记录中主动开启，说明含个人信息、仅最新批7天／50 MiB、单响应1 MiB、排除密钥、启动／访问到期清理及关闭期间下次启动清理。关开关或清除完整记录不删除结论或撤销。调用过程逐次显示状态和已知用量，未知用量不显示为零成本。仅未获得有效判断的失败可重试，要求7天内同账号／规则／范围及inputHash一致；说明会再次消耗额度，保留旧尝试，不提供反复抽取低把握答案的入口。

## 确认与恢复

常驻工具栏显示删除、移动…、归档、垃圾邮件、已读、未读、星标、取消星标及固定名称「整理」。无选择时全部禁用。「整理」仅在命中页、有效分析和可执行选中集合下为深灰可用，其他分类为浅灰禁用；可用性同时使用原生 disabled 和文字提示表达。

「整理」与手动动作使用原生 dialog 模态确认窗口，初始焦点在取消按钮，背景不可交互；取消／Escape 恢复原触发焦点。明确确认后才执行。规则确认只展示实际执行数量、动作与目标、必要的删除和最近批次撤销说明，不再列出主执行邮件清单；有排除项时保留跳过数量及原因。手动确认保留准备处理、将跳过、暂不能处理及逐封检查。目标来自检查结果，变更目标清空旧计划，保留修复入口并要求重查。手动动作不受 AI 判断或规则摘要限制，仍须核对身份与当前位置。

邮件区的正常预检只显示动作去向，不提供折叠、重查按钮或重复检查说明。失败修复集中于「设置 → 管理规则」顶部，分析前检查失败自动进入；保存并检查通过后返回邮件。工作区及设置页不显示底部隐私说明或快捷链接，隐私与运行记录仍从设置分类进入。

正常操作回执位于主区底部，显示真实数量、去向、刷新和撤销，更新时间可展开。部分失败／未知自动展开，异常项只来自最近操作批次的 `CleanupSummary.issues`，不推断当前列表中其他批次的失败。操作封数与文件夹只读核对条数分别展示。未知结果只能先核对，不展示盲重试或乐观成功。

仅最近一批可撤销；新批次替换撤销记录的限制在确认中说明。账号、位置、UIDVALIDITY、指纹和规则语义的检查继续由核心执行，不由视觉状态授权。

## 控件与可访问性

统一10px输入、12px按钮和8px行状态。常驻列表保持平面；菜单、短暂通知与顶部操作条可有轻阴影。按钮颜色／边界过渡160ms，减少动态效果偏好关闭过渡；不依赖动画表达执行成功。

所有输入有名称，控件有可见焦点，禁用状态保留原因。错误和待核对状态持续可见，普通成功提示约5秒关闭。没有结果时区分搜索为空、选择为空和未分析。长主题、路径和错误可换行或展开全文，左栏规则描述默认收起，展开后显示全文；管理页显示完整条件。正文绝不执行 HTML、下载附件或远程图片。

## 当前证据

此前 PreVibe 重构与双入口澄清的验证保留在[实施记录](docs/product-design-review-2026-10-06.md#12-实施记录)，与本轮分别记录。此前 AI 优先工作区已通过类型检查、155项核心／HTTP／TLS测试、生产构建和32项完整浏览器流程。最终冲突选择后默认勾选修复另经2项针对回归及类型／构建检查；1440px桌面和390px窄窗合成截图已更新。原生菜单、生产包 smoke 与本机安装资源检查通过；实际 Arc 页面目视确认四类结果、固定栏和启动分析。配置、报告及最近操作加密文件校验值保持一致。上述数量与安装结果属于当时版本，不证明本次精简和模态确认；本次结果单独追加到实施记录。

`.impeccable/review/` 及早期设计图属于历史资料。合成界面回归不代表真实用户已理解，不据此声称真实邮箱、模型质量或跨机器验收。

逐次调用证据与受限失败分析重试已实现；增量分类、继续尚未读取的整个范围、小样本试规则和超大邮箱性能仍是后续独立迭代，不由视觉回归代替验收。

2026-10-10 文案统一：当前名称与说明以[文案对照表](docs/ui-copy.zh-CN.md)为准。菜单、按钮和状态用日常中文；必要说明分句保留。此次不改布局、字体或处理逻辑。
