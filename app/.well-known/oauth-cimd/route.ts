export async function GET(request: Request) {
  const origin = new URL(request.url).origin
  return Response.json({
    client_id: `${origin}/.well-known/oauth-cimd`,
    client_name: "Avatar AI",
    client_uri: origin,
    logo_uri: `${origin}/favicon.svg`,
    redirect_uris: [`${origin}/?oauth_provider=huggingface`],
    response_types: ["code"],
    grant_types: ["authorization_code"],
    token_endpoint_auth_method: "none",
    scope: "openid profile inference-api",
  })
}
