import type { Category } from '../src/shared/contracts';

// Fictional messages and proposed reference labels. Model accuracy requires an explicit paid run.
// Cases with enabledRules isolate a preset so another matching preset cannot hide a regression.
export interface QualityCase {
  name: string; subject: string; text: string; expected: Category; date?: string;
  custom?: string; enabledRules?: string[];
}
export const qualityCases: QualityCase[] = [
  { name: '中文广告', subject: '限时八折', text: '全场商品八折，立即购买。点击退订。', expected: 'clean' },
  { name: '英文广告', subject: 'Save 20% today', text: 'Shop our sale. Everything is 20% off. Unsubscribe.', expected: 'clean' },
  { name: '无日期的厂商公开课营销', subject: '免费了解我们的产品', text: '晨星软件向所有订阅者邀请报名免费公开课，学习使用我们的付费产品。活动日期稍后通知。点击退订。', expected: 'clean' },
  { name: '尚未结束的厂商峰会营销', subject: '晨星产品峰会邀您报名', text: '向所有订阅者推广我们的产品峰会，介绍付费服务和试用方案。活动结束于2026-12-20。点击退订。', expected: 'clean' },
  { name: '付款凭证附带优惠', subject: '付款成功', text: '您的订单已支付人民币120元，请保留此付款凭证。页脚附有下次购物优惠券。', expected: 'keep' },
  { name: '英文订单', subject: 'Order receipt', text: 'Your order #87654 has been paid. Keep this receipt.', expected: 'keep' },
  { name: '物流记录附带推荐', subject: '您的订单已发货', text: '已购买的商品今天发货，请按运单跟踪配送。页脚推荐其他商品。', expected: 'keep' },
  { name: '个人业务沟通', subject: '继续确认项目交付', text: '您好，接着昨天的项目沟通，请确认我们约定的交付清单。', expected: 'keep' },
  { name: '过期验证码', subject: '验证码', text: '验证码：123456，有效期10分钟。', date: '2026-10-02T11:00:00Z', expected: 'clean' },
  { name: '过期验证码附带可疑登录提醒', subject: 'Your sign-in verification code', text: 'Enter this temporary verification code to continue: 123456. We noticed a suspicious sign-in. If that was you, enter this code. If this was not you, reset your password.', expected: 'clean' },
  { name: '有效验证码', subject: '登录验证码', text: '验证码：123456，有效期10分钟。', date: '2026-10-02T11:59:00Z', expected: 'keep' },
  { name: '未注明有效期的新验证码', subject: '注册验证码', text: '本次注册的一次性验证码：123456。如果不是您操作，请忽略。', date: '2026-10-02T11:00:00Z', expected: 'keep' },
  { name: '未来截止的验证码', subject: '一次性身份验证码', text: '验证码：123456，本次验证码截止于2026-10-03。', expected: 'keep' },
  { name: '恢复码', subject: '账号恢复码', text: '这是您的长期账号恢复码，请妥善保存。', expected: 'keep' },
  { name: '长期激活码', subject: '您的永久许可证', text: '此激活码长期有效，用于您购买的软件永久许可证，请妥善保存。', expected: 'keep' },
  { name: '独立安全告警提到验证码', subject: '账号存在异常登录', text: '发现未经授权的设备已经登录您的账号。请撤销该设备并检查近期登录记录。请勿向他人透露验证码或密码。', expected: 'keep' },
  { name: '过期活动介绍', subject: '社区讲座介绍', text: '欢迎参加社区公益讲座。活动于2026-09-20结束。', expected: 'clean', enabledRules: ['events'] },
  { name: '报名截止但活动尚未开始', subject: '社区活动报名邀请', text: '邀请您报名参加社区公益活动，最终报名截止日期为2026-09-20，活动于2026-12-20结束。欢迎填写报名表。', expected: 'clean', enabledRules: ['events'] },
  { name: '未来活动', subject: '社区讲座介绍', text: '欢迎参加社区公益讲座。活动于2026-12-20结束。', expected: 'keep', enabledRules: ['events'] },
  { name: '没有活动日期', subject: '社区讲座报名', text: '欢迎报名参加社区公益讲座。活动时间及报名截止时间另行通知。', expected: 'review', enabledRules: ['events'] },
  { name: '没有年份的活动日期', subject: '社区活动介绍', text: '活动结束于9月20日。欢迎参加。', expected: 'review', enabledRules: ['events'] },
  { name: '多场活动最后一场未结束', subject: '社区系列讲座', text: '第一场于2026-09-20结束，最后一场于2026-12-20结束。本邮件介绍整个系列活动。', expected: 'keep', enabledRules: ['events'] },
  { name: '旧门票附带推荐', subject: '报名成功及门票', text: '您已报名成功，这是门票和付款凭证。活动于2026-09-20结束。页脚推荐其他活动。', expected: 'keep' },
  { name: '个人预约变更', subject: '预约改期需要确认', text: '针对您已预约的会面，原日期2026-09-20已取消，请回复确认新的安排。', expected: 'keep' },
  { name: '旧点赞通知', subject: '有人赞了你的动态', text: '系统通知：一位用户点赞了你的动态。查看详情。', expected: 'clean', enabledRules: ['notifications'] },
  { name: '新点赞通知', subject: '有人赞了你的动态', text: '系统通知：一位用户点赞了你的动态。查看详情。', date: '2026-10-01T11:00:00Z', expected: 'keep', enabledRules: ['notifications'] },
  { name: '内容推荐附带私信功能介绍', subject: '本周为你推荐的文章', text: '为你自动推荐五篇热门文章。你也可以使用私信功能联系作者。查看详情。', expected: 'clean', enabledRules: ['notifications'] },
  { name: '旧社交动态汇总', subject: '你关注的用户本周动态', text: '自动汇总你关注的用户发布的公开动态。查看详情。', expected: 'clean', enabledRules: ['notifications'] },
  { name: '旧私信', subject: '发给你的私信', text: '小林给你发了一条私信，请回复我们之前讨论的安排。', expected: 'keep', enabledRules: ['notifications'] },
  { name: '旧评论回复', subject: '有人回复了你的评论', text: '小林回复你之前的评论：请确认你的建议是否仍然适用。', expected: 'keep', enabledRules: ['notifications'] },
  { name: '真实提及通知', subject: '项目讨论中提及了你', text: '小林在项目讨论中直接提及你，请你补充负责的部分。', expected: 'keep', enabledRules: ['notifications'] },
  { name: '旧任务指派', subject: '分配给你的任务', text: '此任务明确指派给你，目前尚未完成，请确认处理。', expected: 'keep', enabledRules: ['notifications'] },
  { name: '新自然语言规则', subject: '推荐职位', text: '本周有五个新的设计师职位。您没有与招聘者开始沟通。', expected: 'clean', custom: '清理招聘职位推荐，但保留已经开始沟通的职位。' },
  { name: '自定义保留例外', subject: '设计师职位沟通', text: '您好，我们接着昨天的沟通，请明天参加面试。', expected: 'keep', custom: '清理招聘职位推荐，但保留已经开始沟通的职位。' },
  { name: '求职者直接投递简历', subject: '应聘产品设计师：个人简历', text: '您好，我想应聘贵公司的产品设计师岗位。我有三年设计工作经历，以下是项目经验和联系方式，期待安排面试。', expected: 'clean', custom: '清理求职者投递的求职简历，不设置时间限制；排除招聘平台推荐岗位的广告。' },
  { name: '简历规则排除岗位推荐', subject: '为你推荐五个设计岗位', text: '招聘平台为您推荐五个新设计职位，欢迎浏览岗位并投递简历。点击退订。', expected: 'keep', custom: '清理求职者投递的求职简历，不设置时间限制；排除招聘平台推荐岗位的广告。' },
];
