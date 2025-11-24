// =================================================================================
//  Project: botzy-2api (Bun Server Edition)
//  Refactored by: CezDev
//  Description: OpenAI-compatible API Proxy for Botzy (Headless / Backend Only)
// =================================================================================

const CONFIG = {
  PROJECT_NAME: "botzy-2api-bun",
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_URL: process.env.UPSTREAM_URL || "https://botzy.hexabiz.com.pk/api/hexabizApi",
  UPSTREAM_ORIGIN: process.env.UPSTREAM_ORIGIN || "https://botzy.hexabiz.com.pk",
  MODELS: ["L1T3-Ωᴹ²"],
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || "L1T3-Ωᴹ²",
};

// --- [Server Entry Point] ---
Bun.serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // Root path check (API Health Check)
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: "ok", service: CONFIG.PROJECT_NAME }), {
        headers: corsHeaders({ 'Content-Type': 'application/json' })
      });
    }

    // API Routing
    if (url.pathname.startsWith('/v1/')) {
      return handleApi(request);
    }

    return new Response(JSON.stringify({
      error: { message: `Path not found: ${url.pathname}`, type: 'invalid_request_error', code: 'not_found' }
    }), { status: 404, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  },
});

console.log(`🚀 Service running at http://localhost:${CONFIG.PORT}`);

// --- [API Handlers] ---

async function handleApi(request) {
  // CORS Preflight
  if (request.method === 'OPTIONS') {
    return handleCorsPreflight();
  }

  // Authentication
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return createErrorResponse('Missing Bearer Token.', 401, 'unauthorized');
  }
  const token = authHeader.substring(7);
  if (token !== CONFIG.API_MASTER_KEY) {
    return createErrorResponse('Invalid API Key.', 403, 'invalid_api_key');
  }

  const url = new URL(request.url);
  // Use generic UUID if crypto.randomUUID is not available (Bun supports it natively)
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`Unsupported path: ${url.pathname}`, 404, 'not_found');
  }
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code } }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'botzy-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

async function handleChatCompletions(request, requestId) {
  try {
    const requestData = await request.json();
    const upstreamPayload = transformRequestToUpstream(requestData);

    // Note: Removed 'cf' object as it is Cloudflare specific
    const upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': CONFIG.UPSTREAM_ORIGIN,
        'Referer': `${CONFIG.UPSTREAM_ORIGIN}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify(upstreamPayload)
    });

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      console.error(`Upstream Error: ${upstreamResponse.status}`, errorBody);
      return createErrorResponse(`Upstream error ${upstreamResponse.status}: ${errorBody}`, upstreamResponse.status, 'upstream_error');
    }

    const contentType = upstreamResponse.headers.get('content-type');
    
    // Handle Streaming
    if (requestData.stream && contentType && contentType.includes('text/event-stream')) {
      const transformStream = createUpstreamToOpenAIStream(requestId, requestData.model || CONFIG.DEFAULT_MODEL);
      // Bun supports piping streams directly in Response
      return new Response(upstreamResponse.body.pipeThrough(transformStream), {
        headers: corsHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Trace-ID': requestId,
        }),
      });
    } else {
      // Handle Non-Streaming
      const fullBody = await upstreamResponse.text();
      const openAIResponse = transformNonStreamResponse(fullBody, requestId, requestData.model || CONFIG.DEFAULT_MODEL);
      return new Response(JSON.stringify(openAIResponse), {
        headers: corsHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'X-Trace-ID': requestId,
        }),
      });
    }

  } catch (e) {
    console.error('Handler Exception:', e);
    return createErrorResponse(`Internal Error: ${e.message}`, 500, 'internal_server_error');
  }
}

// --- [Logic Transformation Helpers] ---

function transformRequestToUpstream(requestData) {
  return {
    task: "chat",
    model: requestData.model || CONFIG.DEFAULT_MODEL,
    messages: requestData.messages, // Assumes upstream accepts OpenAI format directly
    imageUrl: null,
    settings: { avatar: null, name: "", nickname: "", age: 0, gender: "other" }
  };
}

function createUpstreamToOpenAIStream(requestId, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); 

      for (const line of lines) {
        if (line.startsWith('data:')) {
          const dataStr = line.substring(5).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            const delta = data?.choices?.[0]?.delta;
            if (delta && typeof delta.content === 'string') {
              const openAIChunk = {
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{ index: 0, delta: { content: delta.content }, finish_reason: null }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            }
          } catch (e) { /* ignore parse errors */ }
        }
      }
    },
    flush(controller) {
      const finalChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    }
  });
}

function transformNonStreamResponse(fullBody, requestId, model) {
  let fullContent = '';
  const lines = fullBody.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const dataStr = line.substring(5).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const data = JSON.parse(dataStr);
        const content = data?.choices?.[0]?.delta?.content;
        if (content) fullContent += content;
      } catch (e) {}
    }
  }

  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
