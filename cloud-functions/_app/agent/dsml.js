// DSML 工具调用兼容：解析文本调用 + 兜底剥离标记（_worker.js 原第 1116-1190 行）

// ==================== DSML 工具调用兼容（v6.6.4） ====================
// 背景：DeepSeek V3.2 / V4 系模型的服务层（vLLM / SGLang 等）在收到带 tools 的请求时，
// 会往 system prompt 注入一段 "## Tools" 说明，要求模型用
//   <｜DSML｜tool_calls><｜DSML｜invoke name="get_weather">
//   <｜DSML｜parameter name="city" string="true">上海</｜DSML｜parameter>
//   </｜DSML｜invoke></｜DSML｜tool_calls>
// 这种 XML 式标记输出工具调用，并由网关负责把它解析回 OpenAI 标准的 tool_calls 字段。
// 若通道是裸透传（不做这层转换），响应的 message.tool_calls 为空、DSML 原文留在
// message.content 里——Agent 循环会把它当成最终答案直接发给用户（markup 泄漏），
// 且工具一次都不会执行。本节做客户端兼容：
//   1) parseDSMLToolCalls：从 content 解析 DSML → 转成标准 tool_calls 参与执行；
//   2) stripDSMLBlocks：兜底剥离，任何返回给用户的文本都不允许携带 DSML markup。
// 兼容性：外层标签 tool_calls / function_calls / calls 三种变体；全角｜/半角|、
// 标签内多余空格、未闭合（被截断）的块都能容忍；单个 malformed 的 invoke 被跳过，
// 不影响同块内其它调用。v6.8.7：被 max_tokens 截断的最后一个 parameter（未闭合）
// 也照常解析，不再静默丢失。

// 从文本中提取 DSML 工具调用，转成 OpenAI 标准 tool_calls 数组；找不到返回 []。
function parseDSMLToolCalls(content) {
  const text = String(content || '');
  if (text.indexOf('DSML') === -1) return [];
  const calls = [];
  let seq = 0;
  // 外层块（未闭合则截到文末，避免截断输出导致整个解析失败）
  const blockRe = /<\s*[|｜]\s*DSML\s*[|｜]\s*(tool_calls|function_calls|calls)\s*>([\s\S]*?)(?:<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*\1\s*>|$)/g;
  let bm;
  while ((bm = blockRe.exec(text))) {
    const body = bm[2];
    const invRe = /<\s*[|｜]\s*DSML\s*[|｜]\s*invoke\b([^>]*)>([\s\S]*?)(?:<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*invoke\s*>|$)/g;
    let im;
    while ((im = invRe.exec(body))) {
      const nameM = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(im[1] || '');
      const name = nameM ? (nameM[1] !== undefined ? nameM[1] : nameM[2]) : '';
      if (!name) continue;
      const args = {};
      // v6.8.7：末尾兜底分支容忍未闭合的 parameter —— 生成被 max_tokens 截断时，
      // 最后一个参数没有 </DSML|parameter> 收尾，旧正则会把它静默丢掉，
      // 工具拿不到关键参数。截到下一个 parameter 开头、invoke 结束或文本末尾。
      const pRe = /<\s*[|｜]\s*DSML\s*[|｜]\s*parameter\b([^>]*)>([\s\S]*?)(?:<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*parameter\s*>|(?=<\s*[|｜]\s*DSML\s*[|｜]\s*parameter\b)|$)/g;
      let pm;
      while ((pm = pRe.exec(im[2]))) {
        const pnM = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(pm[1] || '');
        const pName = pnM ? (pnM[1] !== undefined ? pnM[1] : pnM[2]) : '';
        if (!pName) continue;
        const sM = /\bstring\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(pm[1] || '');
        const isStr = sM ? (sM[1] !== undefined ? sM[1] : sM[2]) !== 'false' : true;
        const raw = pm[2];
        if (isStr) {
          args[pName] = raw.trim();
        } else {
          try { args[pName] = JSON.parse(raw); }
          catch (e) { args[pName] = raw.trim(); }
        }
      }
      seq += 1;
      calls.push({
        id: 'call_dsml_' + Date.now().toString(36) + '_' + seq,
        type: 'function',
        function: { name: name, arguments: JSON.stringify(args) }
      });
    }
  }
  return calls;
}

// 兜底剥离：删掉文本里残留的 DSML 块（含未闭合的）、零散 DSML 标签，
// 以及 DeepSeek 偶发泄漏的 <｜end▁of▁sentence｜> 结束符。幂等，无 DSML 时原文返回。
function stripDSMLBlocks(content) {
  let text = String(content || '');
  if (text.indexOf('DSML') === -1 && text.indexOf('end▁of▁sentence') === -1) return text;
  // 成对或未闭合的外层块（三种外层标签名，闭合标签名不一致也照删）
  text = text.replace(/<\s*[|｜]\s*DSML\s*[|｜]\s*(?:tool_calls|function_calls|calls)\s*>[\s\S]*?(?:<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*(?:tool_calls|function_calls|calls)\s*>|$)/g, '');
  // 残留的零散 DSML 标签（含属性的也删）
  text = text.replace(/<\s*\/?\s*[|｜]\s*DSML\s*[|｜]\s*[^<>]*>/gi, '');
  // DeepSeek 结束符
  text = text.replace(/<\s*[|｜]\s*end▁of▁sentence\s*[|｜]\s*>/g, '');
  return text;
}

export {
  parseDSMLToolCalls,
  stripDSMLBlocks,
};
