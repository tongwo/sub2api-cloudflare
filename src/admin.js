// admin.js — 管理后台 HTML（被 Worker 直接 serve，无需构建）
// 注意：整个 HTML 包在一个外层模板字符串里，因此内部 <script> 不得再使用反引号，
// 一律用普通字符串拼接，否则会提前结束外层模板字面量。
export const ADMIN_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sub2API-CF 管理后台</title>
<style>
  :root{--bg:#0f1115;--card:#1a1d24;--fg:#e6e6e6;--mut:#9aa0aa;--bd:#2a2f3a;--acc:#4f8cff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:880px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--mut);margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;margin-bottom:16px}
  .card h2{font-size:15px;margin:0 0 12px;color:var(--acc)}
  label{display:block;color:var(--mut);margin:8px 0 4px}
  input,select,textarea{width:100%;background:#0f1115;border:1px solid var(--bd);color:var(--fg);border-radius:6px;padding:8px;font:inherit}
  textarea{height:64px;resize:vertical;font-family:monospace}
  button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer;margin-top:10px}
  pre{background:#0f1115;border:1px solid var(--bd);border-radius:6px;padding:10px;overflow:auto;max-height:280px}
  .row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--bd)}
  .row:last-child{border-bottom:0}
  .tag{font-size:12px;color:var(--mut)}
</style>
</head>
<body>
<div class="wrap">
  <h1>Sub2API-CF 管理后台</h1>
  <div class="sub">纯 Cloudflare Workers + D1 的 AI API 中转站 · 零成本</div>

  <div class="card">
    <h2>管理令牌</h2>
    <label>ADMIN_TOKEN（与部署时 wrangler secret 一致）</label>
    <input id="token" placeholder="粘贴你的 admin token" oninput="reload()">
  </div>

  <div class="card">
    <h2>概览</h2>
    <div id="stat"><span class="tag">填入令牌后自动加载</span></div>
  </div>

  <div class="card">
    <h2>添加上游账号</h2>
    <label>供应商</label>
    <select id="a_provider">
      <option value="openai">OpenAI（含一切 OpenAI 兼容网关）</option>
      <option value="anthropic">Anthropic / Claude</option>
      <option value="gemini">Google Gemini</option>
    </select>
    <label>名称</label><input id="a_name" placeholder="例如：我的 Claude 订阅">
    <label>API Key</label><input id="a_key" placeholder="sk-... / claude key / gemini key">
    <label>Base URL（可选，留空用默认）</label><input id="a_base" placeholder="https://api.openai.com/v1">
    <label>模型别名映射（可选，JSON）</label>
    <textarea id="a_map" placeholder='{"gpt-4o":"gpt-4o"}'></textarea>
    <button onclick="addAccount()">添加账号</button>
    <pre id="a_list">—</pre>
  </div>

  <div class="card">
    <h2>批量导入账号（Sub2API 格式）</h2>
    <label>平台（用于 Codex 风格 content 导入）</label>
    <select id="i_platform">
      <option value="openai">OpenAI</option>
      <option value="anthropic">Anthropic / Claude</option>
      <option value="gemini">Google Gemini</option>
      <option value="grok">xAI / Grok</option>
      <option value="antigravity">Antigravity</option>
    </select>
    <label>导入内容（支持两种格式，任选其一）</label>
    <textarea id="i_payload" style="height:160px" placeholder='格式A（简化数组）：
[
  {"name":"acc1","platform":"openai","type":"api_key","credentials":{"api_key":"sk-xxx"}},
  {"name":"acc2","platform":"gemini","type":"oauth","credentials":{"access_token":"...","refresh_token":"...","expires_at":1735689600000}}
]

格式B（Sub2API Codex 风格）：
{"content":"eyJ...","contents":["eyJ..."],"name":"batch","platform":"openai"}'></textarea>
    <div class="row">
      <label style="margin:0">或上传 JSON 文件</label>
      <input id="i_file" type="file" accept=".json,application/json" style="width:auto">
    </div>
    <button onclick="importAccounts()">导入</button>
    <pre id="i_out">—</pre>
  </div>

  <div class="card">
    <h2>生成用户 API Key</h2>
    <label>备注</label><input id="k_label" placeholder="例如：小明 / 团队A">
    <label>额度上限 tokens（可选，留空=不限）</label><input id="k_quota" placeholder="例如 1000000">
    <button onclick="addKey()">生成 Key</button>
    <pre id="k_out">—</pre>
    <h2 style="margin-top:16px">已有 Key</h2>
    <pre id="k_list">—</pre>
  </div>
</div>

<script>
var $=function(id){return document.getElementById(id);};
function token(){return $("token").value.trim();}
function reload(){if(token()){loadStats();loadAccounts();loadKeys();}}

function api(path,opts){
  opts=opts||{};
  return fetch(path,{method:opts.method||"GET",body:opts.body,headers:Object.assign({},opts.headers,{"x-admin-token":token()})})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j;});});
}
function loadStats(){
  api("/admin/stats").then(function(s){
    $("stat").innerHTML=
      '<div><b>'+s.total_tokens+'</b>累计 tokens</div>'+
      '<div><b>'+s.calls+'</b>调用次数</div>'+
      '<div><b>'+s.active_keys+'</b>可用 Key</div>'+
      '<div><b>'+s.active_accounts+'</b>可用账号</div>';
  }).catch(function(e){$("stat").innerHTML='<span class="err">'+e.message+'</span>';});
}
function loadAccounts(){
  api("/admin/accounts").then(function(a){$("a_list").textContent=JSON.stringify(a,null,2);})
    .catch(function(e){$("a_list").textContent="错误："+e.message;});
}
function loadKeys(){
  api("/admin/keys").then(function(k){$("k_list").textContent=JSON.stringify(k,null,2);})
    .catch(function(e){$("k_list").textContent="错误："+e.message;});
}
function addAccount(){
  api("/admin/accounts",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({
      provider:$("a_provider").value, name:$("a_name").value, api_key:$("a_key").value,
      base_url:$("a_base").value,
      model_map:$("a_map").value?JSON.parse($("a_map").value):{}})})
  .then(function(){$("a_name").value="";$("a_key").value="";$("a_base").value="";$("a_map").value="";loadAccounts();loadStats();})
  .catch(function(e){alert("添加失败："+e.message);});
}
function importAccounts(){
  var raw = $("i_payload").value.trim();
  if (!raw && $("i_file").files.length) {
    var f = $("i_file").files[0];
    var fr = new FileReader();
    fr.onload = function(){ doImport(fr.result); };
    fr.readAsText(f);
    return;
  }
  doImport(raw);
}
function doImport(raw){
  var payload;
  try { payload = JSON.parse(raw); } catch(e){ alert("JSON 解析失败："+e.message); return; }
  // 若是 Codex 风格对象，补 platform
  if (payload && !Array.isArray(payload) && typeof payload === "object" && !payload.platform && payload.content) {
    payload.platform = $("i_platform").value;
  }
  api("/admin/accounts/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){
      $("i_out").textContent = JSON.stringify(r,null,2);
      loadAccounts(); loadStats();
    })
    .catch(function(e){ $("i_out").textContent = "导入失败："+e.message; });
}
function addKey(){
  api("/admin/keys",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({label:$("k_label").value,quota_tokens:$("k_quota").value?Number($("k_quota").value):null})})
  .then(function(r){$("k_out").textContent="新 Key（请妥善保存）：\n\n"+r.key;loadKeys();loadStats();})
  .catch(function(e){alert("生成失败："+e.message);});
}

// 支持从 URL 读取令牌：/admin?token=xxx 打开即自动加载，无需手动粘贴
(function(){
  try {
    var t = new URLSearchParams(location.search).get("token");
    if (t) { $("token").value = t; reload(); }
  } catch(e) {}
})();
</script>
</body>
</html>`;
