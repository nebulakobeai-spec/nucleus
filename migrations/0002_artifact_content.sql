-- artifact 的内容此前**从未被保存**。
--
-- writeArtifact 收到 content，只把 content.length 存进 bytes 就丢掉了原文。
-- 后果最重的地方是 write_report —— 专家交付主要成果用的工具：
-- 一次真实运行产出 17081 字节的报告，落库只剩「17081」和一句 summary，
-- 报告本身在任何地方都不存在。
--
-- 而整套 context 策略正是建立在「summary 只写结论，完整内容进 artifact
-- 后引用」之上。引用指向的东西不存在，这个策略就是空的。
--
-- write_file 侥幸没丢（它自己 writeFile 落盘了），但那份内容只在本机
-- /tmp 下，多 worker 部署或重启清理后同样拿不到。所以内容的权威副本
-- 应当在数据库里。
alter table artifacts add column if not exists content text;

-- sha256 列一开始就声明了，也一直没人写。内容有了之后它才有意义：
-- 同一 ref 被覆盖写时，用它判断内容是否真的变了。
comment on column artifacts.content is '权威副本。write_file 会额外落盘供其它工具读取，但以此列为准。';
