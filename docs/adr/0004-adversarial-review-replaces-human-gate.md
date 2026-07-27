# 用对抗评审（Producer→Critic）替代人工 GATE，保持全自动

不设人工大纲关卡（你倾向全自动），改用双 agent 对抗评审保证质量：Producer（Architect / Writer）出草稿，Critic 依据明确验收标准返回 `approve`/`reject`+修改点，Producer 据此修订，**最多 2 轮**，到上限仍未通过则接受最后版本并记录告警。作用范围 = Outline + 每章 Write（Survey/Research 是低歧义事实抽取，不评）。Critic 首轮通过即短路，所以多数章节只多花一次 Critic 调用；只有争议章节才进入修订。这样在全自动流水线下仍有质量把关，且成本有界。
