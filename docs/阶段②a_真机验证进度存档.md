# 阶段②a 真机验证进度存档（2026-08-09）

> 本文档记录"相机 FTP 直传手机热点"UTS 插件真机验证的完整进度，供后续继续（对话记录可能折叠）。

## 一、当前状态：编码完成，真机验证进行中（最后一公里）

**已完全解决**：
- ✅ UTS 插件 ftp-receiver 全部编码完成（src/uni_modules/ftp-receiver/，17+ 文件）
- ✅ 白屏问题（uni_modules 目录位置、import 写法、UTS 语法）已修复
- ✅ 3 轮 Kotlin 编译错误已修复（onTimeout 签名、import 路径、String 构造、getPath 实验性 API、Context 可空、lambda 签名）
- ✅ 测试页已能在手机显示（不再白屏）
- ✅ 依赖已装（@dcloudio/uni-uts-v1）、缓存已清

**待完成（王总在 HBuilderX 操作）**：
1. 制作自定义调试基座（云端证书 → 切换到普通打包并继续 → 打包，等 3-10 分钟）
2. 运行到手机（本地基座）→ 版本警告点忽略
3. 手机打开"相机直连测试"页 → 点"启动服务"
4. 若仍有编译报错：复制 HBuilderX 控制台日志发给秘书 → 员工继续修（报错已收敛到极少）

## 二、关键操作备忘（HBuilderX）
- 打包：运行 → 运行到手机或模拟器 → 制作自定义调试基座
  - 证书：使用云端证书（公共测试证书已被 DCloud 禁用）
  - 弹"不支持安心打包"→ 切换到普通打包并继续
- 运行：运行 → 运行到手机或模拟器 → 本地基座 → 手机
- 清理缓存：运行 → 清缓存并重新编译（或删除项目 unpackage/dist 目录）
- 版本警告（5.15 vs 5.23）：点忽略，开发测试无碍；正式上线前升级 @dcloudio 依赖

## 三、关键技术结论（踩坑记录）
1. CLI 项目（vite）uni_modules **必须放 src/uni_modules/**（不是项目根）
2. UTS 插件 import 规范：`import { X } from '@/uni_modules/ftp-receiver'`（插件根目录）
3. UTS 转译规则：`import { X } from 'pkg'` → `import pkg.X`，**from 只能写包路径不能带类名**
4. CLI `npx uni build` 只转译不跑 kotlinc——"编译通过"是假象，真实验证必须云打包
5. Android Service.onTimeout 返回 Unit（不是 Int）
6. Kotlin 实验性 API（getPath）在 UTS 中要用稳定替代（absolutePath）
7. UTSAndroid.getAppContext() 返回可空，需判空
8. Promise<void> 的 resolve 签名是 (value: void) => void（Function1）

## 四、待真机验收项（A1-A9，见 UTS 设计文档 §8）
佳能 PASV/PORT 各传 10 张 100%、锁屏 30 分钟、Android 13/14/15 矩阵、CR3 字节一致、命名冲突、异常路径、dataSync 6h 上限

## 五、下一步（真机验证通过后）
阶段②b（iOS，已决策延期）→ 佳能配置引导页（UI 设计稿已就绪 docs/阶段②_引导页与演示页设计.md）→ App 数据管线（docs/阶段②_App照片数据管线设计.md，plus.sqlite 方案）→ 后端 P0
