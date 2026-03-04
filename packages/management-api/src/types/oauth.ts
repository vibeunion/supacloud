export type OAuthProvider =
  | "google"
  | "github"
  | "gitlab"
  | "facebook"
  | "twitter"
  | "apple"
  | "azure"
  | "discord"
  | "spotify"
  | "slack"
  | "linkedin"
  | "twitch"
  | "bitbucket"
  | "figma"
  | "kakao"
  | "keycloak"
  | "workos"
  | "notion"
  | "zoom"
  | "wechat"
  | "wechat_miniprogram"
  | "wechat_mp"
  | "qq"
  | "weibo"
  | "alipay"
  | "dingtalk"
  | "douyin"
  | "baidu"
  | "huawei"
  | "xiaomi"
  | "kuaishou"
  | "bilibili";

export type WeChatProviderType = "wechat" | "wechat_miniprogram" | "wechat_mp";

export type ChinaOAuthProvider = 
  | "qq"
  | "weibo"
  | "alipay"
  | "dingtalk"
  | "douyin"
  | "baidu"
  | "huawei"
  | "xiaomi"
  | "kuaishou"
  | "bilibili";

export interface OAuthProviderConfig {
  provider: OAuthProvider;
  client_id: string;
  client_secret: string;
  redirect_uri?: string;
  url?: string;
}

export interface WeChatProviderConfig extends OAuthProviderConfig {
  provider: WeChatProviderType;
  app_type?: "miniprogram" | "mp" | "open";
}

export interface OAuthConfigResponse {
  [key: string]: {
    client_id: string;
    enabled: boolean;
    redirect_uri?: string;
  };
}

export const OAUTH_ENV_MAPPINGS: Record<OAuthProvider, { clientId: string; clientSecret: string; redirectUri?: string; url?: string }> = {
  google: {
    clientId: "GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_GOOGLE_SECRET",
    redirectUri: "GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI",
  },
  github: {
    clientId: "GOTRUE_EXTERNAL_GITHUB_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_GITHUB_SECRET",
  },
  gitlab: {
    clientId: "GOTRUE_EXTERNAL_GITLAB_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_GITLAB_SECRET",
  },
  facebook: {
    clientId: "GOTRUE_EXTERNAL_FACEBOOK_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_FACEBOOK_SECRET",
  },
  twitter: {
    clientId: "GOTRUE_EXTERNAL_TWITTER_CONSUMER_KEY",
    clientSecret: "GOTRUE_EXTERNAL_TWITTER_CONSUMER_SECRET",
  },
  apple: {
    clientId: "GOTRUE_EXTERNAL_APPLE_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_APPLE_SECRET",
  },
  azure: {
    clientId: "GOTRUE_EXTERNAL_AZURE_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_AZURE_SECRET",
  },
  discord: {
    clientId: "GOTRUE_EXTERNAL_DISCORD_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_DISCORD_SECRET",
  },
  spotify: {
    clientId: "GOTRUE_EXTERNAL_SPOTIFY_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_SPOTIFY_SECRET",
  },
  slack: {
    clientId: "GOTRUE_EXTERNAL_SLACK_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_SLACK_SECRET",
  },
  linkedin: {
    clientId: "GOTRUE_EXTERNAL_LINKEDIN_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_LINKEDIN_SECRET",
  },
  twitch: {
    clientId: "GOTRUE_EXTERNAL_TWITCH_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_TWITCH_SECRET",
  },
  bitbucket: {
    clientId: "GOTRUE_EXTERNAL_BITBUCKET_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_BITBUCKET_SECRET",
  },
  figma: {
    clientId: "GOTRUE_EXTERNAL_FIGMA_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_FIGMA_SECRET",
  },
  kakao: {
    clientId: "GOTRUE_EXTERNAL_KAKAO_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_KAKAO_SECRET",
  },
  keycloak: {
    clientId: "GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_KEYCLOAK_SECRET",
    url: "GOTRUE_EXTERNAL_KEYCLOAK_URL",
  },
  workos: {
    clientId: "GOTRUE_EXTERNAL_WORKOS_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_WORKOS_SECRET",
  },
  notion: {
    clientId: "GOTRUE_EXTERNAL_NOTION_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_NOTION_SECRET",
  },
  zoom: {
    clientId: "GOTRUE_EXTERNAL_ZOOM_CLIENT_ID",
    clientSecret: "GOTRUE_EXTERNAL_ZOOM_SECRET",
  },
  wechat: {
    clientId: "WECHAT_OPEN_APP_ID",
    clientSecret: "WECHAT_OPEN_APP_SECRET",
    redirectUri: "WECHAT_OPEN_REDIRECT_URI",
  },
  wechat_miniprogram: {
    clientId: "WECHAT_MINIPROGRAM_APP_ID",
    clientSecret: "WECHAT_MINIPROGRAM_APP_SECRET",
  },
  wechat_mp: {
    clientId: "WECHAT_MP_APP_ID",
    clientSecret: "WECHAT_MP_APP_SECRET",
    redirectUri: "WECHAT_MP_REDIRECT_URI",
  },
  qq: {
    clientId: "QQ_APP_ID",
    clientSecret: "QQ_APP_KEY",
    redirectUri: "QQ_REDIRECT_URI",
  },
  weibo: {
    clientId: "WEIBO_APP_KEY",
    clientSecret: "WEIBO_APP_SECRET",
    redirectUri: "WEIBO_REDIRECT_URI",
  },
  alipay: {
    clientId: "ALIPAY_APP_ID",
    clientSecret: "ALIPAY_PRIVATE_KEY",
    redirectUri: "ALIPAY_REDIRECT_URI",
  },
  dingtalk: {
    clientId: "DINGTALK_APP_KEY",
    clientSecret: "DINGTALK_APP_SECRET",
    redirectUri: "DINGTALK_REDIRECT_URI",
  },
  douyin: {
    clientId: "DOUYIN_CLIENT_KEY",
    clientSecret: "DOUYIN_CLIENT_SECRET",
    redirectUri: "DOUYIN_REDIRECT_URI",
  },
  baidu: {
    clientId: "BAIDU_API_KEY",
    clientSecret: "BAIDU_SECRET_KEY",
    redirectUri: "BAIDU_REDIRECT_URI",
  },
  huawei: {
    clientId: "HUAWEI_CLIENT_ID",
    clientSecret: "HUAWEI_CLIENT_SECRET",
    redirectUri: "HUAWEI_REDIRECT_URI",
  },
  xiaomi: {
    clientId: "XIAOMI_APP_ID",
    clientSecret: "XIAOMI_APP_SECRET",
    redirectUri: "XIAOMI_REDIRECT_URI",
  },
  kuaishou: {
    clientId: "KUAISHOU_APP_ID",
    clientSecret: "KUAISHOU_APP_SECRET",
    redirectUri: "KUAISHOU_REDIRECT_URI",
  },
  bilibili: {
    clientId: "BILIBILI_APP_ID",
    clientSecret: "BILIBILI_APP_SECRET",
    redirectUri: "BILIBILI_REDIRECT_URI",
  },
};

export const WECHAT_PROVIDER_INFO: Record<WeChatProviderType, { name: string; description: string; loginType: string; isStandardOAuth: boolean }> = {
  wechat: {
    name: "微信开放平台",
    description: "适用于移动 APP 和 H5 网页登录（标准 OAuth2.0）",
    loginType: "open",
    isStandardOAuth: true,
  },
  wechat_miniprogram: {
    name: "微信小程序",
    description: "适用于微信小程序一键登录，通过 Edge Function 实现",
    loginType: "miniprogram",
    isStandardOAuth: false,
  },
  wechat_mp: {
    name: "微信公众号",
    description: "适用于公众号网页授权登录（OAuth2.0 变体，需 Edge Function 代理）",
    loginType: "mp",
    isStandardOAuth: false,
  },
};

export const CHINA_OAUTH_PROVIDER_INFO: Record<ChinaOAuthProvider, { name: string; description: string; isStandardOAuth: boolean; oauthUrl: string }> = {
  qq: {
    name: "QQ",
    description: "腾讯 QQ 登录，适用于网站和移动应用",
    isStandardOAuth: true,
    oauthUrl: "https://graph.qq.com/oauth2.0",
  },
  weibo: {
    name: "微博",
    description: "新浪微博登录，适用于网站和移动应用",
    isStandardOAuth: true,
    oauthUrl: "https://api.weibo.com/oauth2",
  },
  alipay: {
    name: "支付宝",
    description: "支付宝登录，适用于网站和移动应用",
    isStandardOAuth: true,
    oauthUrl: "https://openapi.alipay.com/gateway.do",
  },
  dingtalk: {
    name: "钉钉",
    description: "钉钉登录，适用于企业内部应用和第三方应用",
    isStandardOAuth: true,
    oauthUrl: "https://oapi.dingtalk.com/connect",
  },
  douyin: {
    name: "抖音",
    description: "抖音登录，适用于移动应用和网站",
    isStandardOAuth: true,
    oauthUrl: "https://open.douyin.com/platform/oauth",
  },
  baidu: {
    name: "百度",
    description: "百度账号登录，适用于网站和移动应用",
    isStandardOAuth: true,
    oauthUrl: "https://openapi.baidu.com/oauth/2.0",
  },
  huawei: {
    name: "华为",
    description: "华为账号登录，适用于华为设备应用",
    isStandardOAuth: true,
    oauthUrl: "https://oauth-login.cloud.huawei.com/oauth2/v2",
  },
  xiaomi: {
    name: "小米",
    description: "小米账号登录，适用于小米设备应用",
    isStandardOAuth: true,
    oauthUrl: "https://account.xiaomi.com/oauth2",
  },
  kuaishou: {
    name: "快手",
    description: "快手登录，适用于移动应用和网站",
    isStandardOAuth: true,
    oauthUrl: "https://open.kuaishou.com/oauth2",
  },
  bilibili: {
    name: "哔哩哔哩",
    description: "B站账号登录，适用于网站和移动应用",
    isStandardOAuth: true,
    oauthUrl: "https://passport.bilibili.com/oauth2",
  },
};

export const SUPPORTED_OAUTH_PROVIDERS: OAuthProvider[] = [
  "google",
  "github",
  "gitlab",
  "facebook",
  "twitter",
  "apple",
  "azure",
  "discord",
  "spotify",
  "slack",
  "linkedin",
  "twitch",
  "bitbucket",
  "figma",
  "kakao",
  "keycloak",
  "workos",
  "notion",
  "zoom",
  "wechat",
  "wechat_miniprogram",
  "wechat_mp",
  "qq",
  "weibo",
  "alipay",
  "dingtalk",
  "douyin",
  "baidu",
  "huawei",
  "xiaomi",
  "kuaishou",
  "bilibili",
];
