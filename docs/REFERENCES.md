# 参考项目与设计取舍

以下固定版本用于研究设计，本项目独立实现，没有把参考源码、安装包、运行配置或副本纳入仓库。

| 项目 | 固定版本 | 借鉴方向 |
| --- | --- | --- |
| [OpenFic](https://github.com/syrizelink/OpenFic) | `feb3f53e66f2` | 人物详情、图形与列表 |
| [MuMuAINovel](https://github.com/xiamuceer-j/MuMuAINovel) | `743e5abec18b` | 人物、组织和关系 |
| [AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) | `a61674fad4dd` | 分层规划与场景 |
| [goink](https://github.com/sigpanic/goink) | `0d690d879a89` | 地点层级、空间关系和历史 |
| [oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) | `c3fbbbeaadb1` | 固定设定与动态状态 |
| [show-me-the-story](https://github.com/Nigh/show-me-the-story) | `f790187373f2` | 跨实体关联 |

落地时沿用现有双数据库、作者确认和证据机制；节点保持原标识，状态、关系阶段、编辑修订和布局分别保存。参考项目许可不同，后续直接复用代码前须另行核对相应版本的 LICENSE 与 NOTICE。
