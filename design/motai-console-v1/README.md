# 墨台交互设计原型

设计参数、动效与验收结果见[UI定稿合同](../../docs/motai-ui-design-20261025.md)。这是隔离的合成数据样板，不连接New API或真实网关；所有渠道、价格、余额、探活和请求均为演示数据。

```powershell
node design/motai-console-v1/preview.mjs
```

在本机打开 `http://127.0.0.1:8791/`。服务只监听回环地址，手机尺寸使用浏览器设备仿真；这不等同手机真机验收。无需安装依赖。

五页可操作，渠道新增/编辑、1000候选模型搜索多选、手工补充、主副与启停、价格选择、请求详情、探活间隔和减少动态均只影响内存；刷新页面恢复演示初值。配色沿用现用墨台的深色主题，不新增浅色方案。请求列表与详情显示估算 tok/s，口径为输出 Token ÷ 整次请求耗时。新增渠道默认为停用。API Key字段仅供使用任意合成占位文本，不存入Storage、URL或渠道对象，保存/关闭后清空。

```powershell
node --test design/motai-console-v1/model-state.test.mjs
```

原型按少量静态文件组织：`index.html`外壳、`styles.css`视觉与动效、`app.js`合成交互、`model-state.mjs`纯函数、`preview.mjs`静态预览。正式接线仍按原S3/S5/S6任务和公共模块合同完成，不将此原型作为第二套生产前端长期维护。
