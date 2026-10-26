const apiUrl = 'http://127.0.0.1:1234/v1/chat/completions';

export async function predictWithMcpTools({ model, system, prompt, config = {}, tools, callTool, history = [], maxToolCalls = 12, onEvent = async () => {} }) {
  const allowedTools = new Set(['list_narrative_sources', 'read_narrative_source']);
  if (!Array.isArray(tools) || tools.some(tool => !allowedTools.has(tool.name))) throw Error('This component transport may expose only the read-only narrative-source tools');
  const fields = Object.fromEntries((config.operation?.fields || []).map(field => [field.key, field.value]));
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }];
  const functionTools = tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema || { type: 'object', properties: {} } }
  }));
  let toolCalls = 0;
  const rawResponses = [];

  for (let turn = 0; turn <= maxToolCalls; turn++) {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools: functionTools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        temperature: fields['llm.prediction.temperature'] ?? 0.8,
        max_tokens: fields['llm.prediction.maxPredictedTokens'] ?? fields['llm.prediction.maxTokens'] ?? 3072
      }),
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
    if (!response.ok) throw Error(`LM Studio tool-call API returned HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
    const raw = await response.json();
    rawResponses.push(raw);
    await onEvent({ type: 'model_response', turn, response: raw });
    const message = raw.choices?.[0]?.message;
    if (!message) throw Error('LM Studio tool-call API returned no assistant message');
    messages.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) {
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (!text) throw Error('Regia returned no final text after MCP calls');
      return { text, toolCalls, messages, rawResponses };
    }
    for (const request of calls) {
      toolCalls++;
      if (toolCalls > maxToolCalls) throw Error(`Regia exceeded the ${maxToolCalls}-call read-only tool limit`);
      const name = request.function?.name;
      if (!allowedTools.has(name)) throw Error(`Regia requested a tool outside the read-only allowlist: ${name || '(unnamed)'}`);
      let args;
      try { args = JSON.parse(request.function?.arguments || '{}'); }
      catch { throw Error(`Regia requested ${name || 'an unnamed tool'} with invalid JSON arguments`); }
      await onEvent({ type: 'tool_call', turn, callId: request.id, name, arguments: args });
      let result;
      try { result = await callTool(name, args); }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
      await onEvent({ type: 'tool_result', turn, callId: request.id, name, result });
      const content = (result.content || []).map(item => item.text || '').join('\n') || JSON.stringify(result);
      messages.push({ role: 'tool', tool_call_id: request.id, content: content.slice(0, 120000) });
    }
  }
  throw Error('Regia tool loop ended without a final response');
}
