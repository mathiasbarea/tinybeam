// Known bots by user agent: [pattern, name, category]. This is data, not logic: add or fix entries
// freely. Order matters where one name contains another (AdsBot-Google before Googlebot). Categories are
// listed in docs/spec.md, section 7.
export const BOTS = [
  // AI assistants fetching a page because a person asked them to
  [/ChatGPT-User/i, 'ChatGPT-User', 'ai_user_fetch'],
  [/Claude-User/i, 'Claude-User', 'ai_user_fetch'],
  [/Perplexity-User/i, 'Perplexity-User', 'ai_user_fetch'],
  [/MistralAI-User/i, 'MistralAI-User', 'ai_user_fetch'],
  [/meta-externalfetcher/i, 'Meta-ExternalFetcher', 'ai_user_fetch'],
  [/DuckAssistBot/i, 'DuckAssistBot', 'ai_user_fetch'],
  // AI search indexes
  [/OAI-SearchBot/i, 'OAI-SearchBot', 'ai_search'],
  [/Claude-SearchBot/i, 'Claude-SearchBot', 'ai_search'],
  [/PerplexityBot/i, 'PerplexityBot', 'ai_search'],
  [/YouBot/i, 'YouBot', 'ai_search'],
  // AI training crawlers
  [/GPTBot/i, 'GPTBot', 'ai_training'],
  [/ClaudeBot|anthropic-ai/i, 'ClaudeBot', 'ai_training'],
  [/CCBot/i, 'CCBot', 'ai_training'],
  [/meta-externalagent/i, 'Meta-ExternalAgent', 'ai_training'],
  [/Bytespider/i, 'Bytespider', 'ai_training'],
  [/Amazonbot/i, 'Amazonbot', 'ai_training'],
  [/cohere-ai|cohere-training/i, 'cohere-ai', 'ai_training'],
  [/Google-CloudVertexBot/i, 'Google-CloudVertexBot', 'ai_training'],
  [/Diffbot/i, 'Diffbot', 'ai_training'],
  [/AI2Bot/i, 'AI2Bot', 'ai_training'],
  // Ads
  [/AdsBot-Google/i, 'AdsBot-Google', 'ads'],
  [/Mediapartners-Google/i, 'Mediapartners-Google', 'ads'],
  [/Google-Adwords/i, 'Google-Adwords', 'ads'],
  // Search engines
  [/Googlebot|Google-InspectionTool|GoogleOther/i, 'Googlebot', 'search'],
  [/bingbot|BingPreview/i, 'Bingbot', 'search'],
  [/Applebot/i, 'Applebot', 'search'],
  [/DuckDuckBot/i, 'DuckDuckBot', 'search'],
  [/YandexBot|YandexImages|YandexMobileBot/i, 'YandexBot', 'search'],
  [/Baiduspider/i, 'Baiduspider', 'search'],
  [/Yahoo! Slurp/i, 'Yahoo Slurp', 'search'],
  [/SeznamBot/i, 'SeznamBot', 'search'],
  [/PetalBot/i, 'PetalBot', 'search'],
  [/Yeti\//, 'Naver Yeti', 'search'],
  [/Sogou/i, 'Sogou', 'search'],
  [/Qwantbot/i, 'Qwantbot', 'search'],
  [/MojeekBot/i, 'MojeekBot', 'search'],
  // Link previews in social networks and messaging apps
  [/facebookexternalhit|Facebot/i, 'facebookexternalhit', 'social_preview'],
  [/Twitterbot/i, 'Twitterbot', 'social_preview'],
  [/LinkedInBot/i, 'LinkedInBot', 'social_preview'],
  [/Slackbot|Slack-ImgProxy/i, 'Slackbot', 'social_preview'],
  [/WhatsApp/i, 'WhatsApp', 'social_preview'],
  [/Discordbot/i, 'Discordbot', 'social_preview'],
  [/TelegramBot/i, 'TelegramBot', 'social_preview'],
  [/Pinterest/i, 'Pinterestbot', 'social_preview'],
  [/redditbot/i, 'redditbot', 'social_preview'],
  [/SkypeUriPreview/i, 'SkypeUriPreview', 'social_preview'],
  [/Bluesky Cardyb/i, 'Bluesky', 'social_preview'],
  [/Mastodon\//i, 'Mastodon', 'social_preview'],
  [/vkShare/i, 'vkShare', 'social_preview'],
  [/Embedly|Iframely/i, 'Embed service', 'social_preview'],
  // SEO tools
  [/AhrefsBot|AhrefsSiteAudit/i, 'AhrefsBot', 'seo_tool'],
  [/SemrushBot|SiteAuditBot/i, 'SemrushBot', 'seo_tool'],
  [/MJ12bot/i, 'MJ12bot', 'seo_tool'],
  [/DotBot/i, 'DotBot', 'seo_tool'],
  [/rogerbot/i, 'Moz rogerbot', 'seo_tool'],
  [/Screaming Frog/i, 'Screaming Frog', 'seo_tool'],
  [/DataForSeoBot/i, 'DataForSeoBot', 'seo_tool'],
  [/serpstatbot/i, 'serpstatbot', 'seo_tool'],
  [/BLEXBot/i, 'BLEXBot', 'seo_tool'],
  [/Barkrowler/i, 'Barkrowler', 'seo_tool'],
  // Monitoring and audits
  [/UptimeRobot/i, 'UptimeRobot', 'monitoring'],
  [/Pingdom/i, 'Pingdom', 'monitoring'],
  [/StatusCake/i, 'StatusCake', 'monitoring'],
  [/Better Uptime|Better Stack|BetterStack/i, 'Better Stack', 'monitoring'],
  [/Site24x7/i, 'Site24x7', 'monitoring'],
  [/Datadog/i, 'Datadog', 'monitoring'],
  [/Checkly/i, 'Checkly', 'monitoring'],
  [/Chrome-Lighthouse|PageSpeed/i, 'Lighthouse', 'monitoring'],
  // Feed readers
  [/Feedly|Feedbin|NewsBlur|Inoreader|FreshRSS|Tiny Tiny RSS|Miniflux/i, 'Feed reader', 'feed'],
];

const AUTOMATION = /HeadlessChrome|PhantomJS|Playwright|Puppeteer|Selenium|Cypress/i;
const HTTP_CLIENTS = /^(curl|Wget|python-requests|Python-urllib|python-httpx|aiohttp|Go-http-client|axios|node-fetch|undici|got|okhttp|Java\/|Apache-HttpClient|libwww-perl|Ruby|PHP|Scrapy|HTTPie|PostmanRuntime|Deno)\b/i;
const GENERIC = /bot\b|bot\/|crawl|spider|scrape|fetcher|scanner|archiver|indexer/i;

// Returns null for humans, or { name, category, verified } for bots. `webdriver` is the script's `wd`
// flag; `verifiedCategory` is a platform signal such as Cloudflare's request.cf.verifiedBotCategory.
export function classifyBot(userAgent, { webdriver = false, verifiedCategory = null } = {}) {
  const ua = userAgent || '';
  const verified = Boolean(verifiedCategory);
  if (!ua) return { name: null, category: 'unidentified', verified };
  for (const [pattern, name, category] of BOTS) {
    if (pattern.test(ua)) return { name, category, verified };
  }
  if (AUTOMATION.test(ua) || webdriver) return { name: (ua.match(AUTOMATION) || [])[0] || null, category: 'automation', verified };
  if (HTTP_CLIENTS.test(ua)) return { name: ua.match(HTTP_CLIENTS)[1], category: 'http_client', verified };
  if (GENERIC.test(ua) || verified) return { name: null, category: 'unidentified', verified };
  return null;
}
