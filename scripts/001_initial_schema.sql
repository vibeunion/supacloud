-- ============================================================
-- AoristCross - Initial Database Schema
-- Corresponds to all 16 resource modules defined in admin/src/resources.ts
-- ============================================================

-- 0. Extensions & Utility Functions
-- -----------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "moddatetime" SCHEMA extensions;

-- Unified creation function for updated_at auto-update trigger
CREATE OR REPLACE FUNCTION create_updated_at_trigger(tbl regclass)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s
     FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at)',
    tbl
  );
END;
$$;


-- ============================================================
-- 1. Users and Permissions
-- ============================================================

-- 1.1 profiles - User profiles (1:1 with auth.users)
CREATE TABLE profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text,
  phone         text,
  role          text NOT NULL DEFAULT 'free'
                CHECK (role IN ('admin','pro','free')),
  usage_quota   jsonb DEFAULT '{}'::jsonb,
  pattern_used  int  DEFAULT 0,
  mockup_used   int  DEFAULT 0,
  title_used    int  DEFAULT 0,
  video_used    int  DEFAULT 0,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('profiles');
CREATE INDEX idx_profiles_role       ON profiles(role);
CREATE INDEX idx_profiles_phone      ON profiles(phone);
CREATE INDEX idx_profiles_created_at ON profiles(created_at);


-- 1.2 activation_codes - Activation codes
CREATE TABLE activation_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  role          text NOT NULL DEFAULT 'free'
                CHECK (role IN ('pro','free')),
  initial_quota jsonb,
  is_used       boolean NOT NULL DEFAULT false,
  used_by       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  used_at       timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE activation_codes ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('activation_codes');
CREATE INDEX idx_activation_codes_is_used ON activation_codes(is_used);


-- 1.3 subscription_plans - Subscription plans
CREATE TABLE subscription_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  code           text NOT NULL UNIQUE,
  price_monthly  numeric(10,2) NOT NULL,
  price_yearly   numeric(10,2),
  pattern_quota  int,
  mockup_quota   int,
  title_quota    int,
  video_quota    int,
  agent_quota    int,
  features       jsonb DEFAULT '[]'::jsonb,
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     int DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('subscription_plans');


-- ============================================================
-- 2. AI Content Generation
-- ============================================================

-- 2.1 patterns - Pattern management
CREATE TABLE patterns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  code           text,
  batch_prefix   text,
  preview_url    text,
  source_type    text CHECK (source_type IN ('upload','gallery','ai_prompt')),
  crop_model     text CHECK (crop_model IN ('auto','center','fill')),
  fission_model  text CHECK (fission_model IN ('style_transfer','element_recombine','aigc_enhance')),
  fission_count  int,
  matting_model   text CHECK (matting_model IN ('general','detail','speed')),
  style          text CHECK (style IN ('abstract','geometric','floral','animal','cartoon',
                   'vintage','cyberpunk','watercolor','minimalist','ethnic','popart')),
  prompt         text,
  user_id        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  variant_count  int DEFAULT 0,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('generating','draft','published','archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE patterns ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('patterns');
CREATE INDEX idx_patterns_user_id    ON patterns(user_id);
CREATE INDEX idx_patterns_status     ON patterns(status);
CREATE INDEX idx_patterns_style      ON patterns(style);
CREATE INDEX idx_patterns_created_at ON patterns(created_at);


-- 2.2 mockup_categories - Mockup categories (must be created before mockup_templates)
CREATE TABLE mockup_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text NOT NULL,
  code            text NOT NULL UNIQUE,
  icon            text,
  template_count  int DEFAULT 0,
  sort_order      int DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mockup_categories ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('mockup_categories');


-- 2.3 mockup_templates - Mockup templates
CREATE TABLE mockup_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  code             text NOT NULL UNIQUE,
  category_id      uuid REFERENCES mockup_categories(id) ON DELETE SET NULL,
  thumbnail        text,
  product_type     text CHECK (product_type IN ('tshirt','hoodie','hat','towel','phonecase','mug','totebag')),
  supported_angles text,
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','disabled')),
  sort_order       int DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mockup_templates ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('mockup_templates');
CREATE INDEX idx_mockup_templates_category ON mockup_templates(category_id);
CREATE INDEX idx_mockup_templates_product  ON mockup_templates(product_type);


-- 2.4 mockups - Rendered mockups
CREATE TABLE mockups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  pattern_id    uuid REFERENCES patterns(id) ON DELETE SET NULL,
  pattern_code  text,
  template_id   uuid REFERENCES mockup_templates(id) ON DELETE SET NULL,
  render_url    text,
  angle         text CHECK (angle IN ('front','back','detail','scene')),
  product_type  text CHECK (product_type IN ('tshirt','hoodie','hat','towel','phonecase','mug','totebag')),
  user_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'rendering'
                CHECK (status IN ('rendering','completed','failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mockups ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('mockups');
CREATE INDEX idx_mockups_user_id    ON mockups(user_id);
CREATE INDEX idx_mockups_pattern_id ON mockups(pattern_id);
CREATE INDEX idx_mockups_status     ON mockups(status);
CREATE INDEX idx_mockups_created_at ON mockups(created_at);


-- 2.5 titles - Generated titles
CREATE TABLE titles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id      uuid REFERENCES patterns(id) ON DELETE SET NULL,
  pattern_code    text,
  material        text,
  design_style    text,
  audience        text,
  keywords        text,
  generated_title text,
  candidate_count int DEFAULT 0,
  linked_mockups  int DEFAULT 0,
  platform        text CHECK (platform IN ('amazon','etsy','shopee','tiktok','ebay')),
  language        text CHECK (language IN ('en','ja','de','fr','es')),
  seo_score       int,
  user_id         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE titles ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('titles');
CREATE INDEX idx_titles_user_id    ON titles(user_id);
CREATE INDEX idx_titles_pattern_id ON titles(pattern_id);
CREATE INDEX idx_titles_platform   ON titles(platform);
CREATE INDEX idx_titles_created_at ON titles(created_at);


-- 2.6 video_presets - Video preset templates
CREATE TABLE video_presets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  model_type    text,
  scene         text,
  lens          text,
  ratios        text,
  duration      int,
  style_preset  text,
  music         text,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE video_presets ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('video_presets');


-- 2.7 videos - Video records
CREATE TABLE videos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text,
  code             text,
  source_image_url text,
  video_url        text,
  model_type       text CHECK (model_type IN ('none','ea-f','ea-m','we-f','we-m','af-f','af-m','in-f','in-m')),
  scene            text CHECK (scene IN ('solid','studio','street','office','nature','sport','mall','home')),
  lens             text CHECK (lens IN ('medium','closeup','orbit','low','pan','pullback')),
  aspect_ratio     text CHECK (aspect_ratio IN ('9:16','4:3','1:1','16:9')),
  duration         int,
  style_mode       text CHECK (style_mode IN ('preset','custom','random')),
  style_preset     text,
  music            text CHECK (music IN ('none','upbeat','electronic','ambient','custom')),
  custom_prompt    text,
  source_id        text,
  user_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','generating','completed','failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('videos');
CREATE INDEX idx_videos_user_id    ON videos(user_id);
CREATE INDEX idx_videos_status     ON videos(status);
CREATE INDEX idx_videos_created_at ON videos(created_at);


-- ============================================================
-- 3. Operations Data
-- ============================================================

-- 3.1 trending_products - Trending products
CREATE TABLE trending_products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  style        text,
  platform     text CHECK (platform IN ('amazon','etsy','redbubble','teepublic','shein','tiktok','merch')),
  region       text CHECK (region IN ('US','UK','DE','JP','CA','AU')),
  category     text CHECK (category IN ('tshirt','hoodie','hat','phone_case','mug','tote_bag','pillow','sticker')),
  bsr          int,
  sales        int,
  price        text,
  rating       numeric(3,1),
  trend        text,
  thumbnail    text,
  product_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trending_products ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('trending_products');
CREATE INDEX idx_trending_platform   ON trending_products(platform);
CREATE INDEX idx_trending_region     ON trending_products(region);
CREATE INDEX idx_trending_bsr        ON trending_products(bsr);
CREATE INDEX idx_trending_created_at ON trending_products(created_at);


-- 3.2 gallery_assets - Image gallery assets
CREATE TABLE gallery_assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  code        text,
  source      text CHECK (source IN ('pattern','mockup','video','trending','upload')),
  file_type   text CHECK (file_type IN ('image','video')),
  thumbnail   text,
  file_url    text,
  file_size   bigint,
  risk        text CHECK (risk IN ('low','medium','high')),
  user_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gallery_assets ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('gallery_assets');
CREATE INDEX idx_gallery_user_id    ON gallery_assets(user_id);
CREATE INDEX idx_gallery_source     ON gallery_assets(source);
CREATE INDEX idx_gallery_created_at ON gallery_assets(created_at);


-- 3.3 exports - Export records
CREATE TABLE exports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_name     text,
  item_count     int DEFAULT 0,
  content_types  text,
  format         text CHECK (format IN ('zip','csv','json')),
  user_id        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing','completed','failed')),
  download_url   text,
  file_size      bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('exports');
CREATE INDEX idx_exports_user_id    ON exports(user_id);
CREATE INDEX idx_exports_status     ON exports(status);
CREATE INDEX idx_exports_created_at ON exports(created_at);


-- 3.4 tasks - Task queue
CREATE TABLE tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  type           text NOT NULL
                 CHECK (type IN ('pattern','mockup','title','video','export','agent','crop','matting')),
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  progress       int DEFAULT 0,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  error_message  text,
  duration_ms    int,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('tasks');
CREATE INDEX idx_tasks_user_id    ON tasks(user_id);
CREATE INDEX idx_tasks_type       ON tasks(type);
CREATE INDEX idx_tasks_status     ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at);
CREATE INDEX idx_tasks_user_created_desc ON tasks(user_id, created_at DESC);
CREATE INDEX idx_tasks_user_status_created_desc ON tasks(user_id, status, created_at DESC);


-- ============================================================
-- 4. AI Agents
-- ============================================================

-- 4.1 agents - AI agents
CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  model         text NOT NULL
                CHECK (model IN ('gpt-4o','gpt-4o-mini','claude-3.5-sonnet','deepseek-v3','custom')),
  system_prompt text,
  temperature   numeric(3,2),
  max_tokens    int,
  status        text NOT NULL DEFAULT 'offline'
                CHECK (status IN ('online','offline','error')),
  authorized    boolean NOT NULL DEFAULT false,
  calls         int DEFAULT 0,
  quota         int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('agents');
CREATE INDEX idx_agents_status     ON agents(status);
CREATE INDEX idx_agents_created_at ON agents(created_at);


-- 4.2 agent_logs - Agent invocation logs
CREATE TABLE agent_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  input_summary   text,
  output_summary  text,
  tokens_used     int,
  duration_ms     int,
  status          text NOT NULL DEFAULT 'success'
                  CHECK (status IN ('success','failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_agent_logs_agent_id   ON agent_logs(agent_id);
CREATE INDEX idx_agent_logs_user_id    ON agent_logs(user_id);
CREATE INDEX idx_agent_logs_status     ON agent_logs(status);
CREATE INDEX idx_agent_logs_created_at ON agent_logs(created_at);


-- ============================================================
-- 5. System Configuration
-- ============================================================

-- 5.1 system_configs - K/V configuration items (primary key is key)
CREATE TABLE system_configs (
  key          text PRIMARY KEY,
  value        text NOT NULL,
  description  text,
  category     text CHECK (category IN ('ai_keys','image_service','video_service','third_party','system')),
  is_secret    boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE system_configs ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('system_configs');


-- 5.2 help_articles - Help documentation
CREATE TABLE help_articles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  category     text CHECK (category IN ('quickstart','pattern','mockup','title','video','agent','export','billing','faq')),
  content      text,
  sort_order   int DEFAULT 0,
  is_published boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE help_articles ENABLE ROW LEVEL SECURITY;
SELECT create_updated_at_trigger('help_articles');
CREATE INDEX idx_help_articles_category ON help_articles(category);


-- ============================================================
-- 6. Cleanup Helper Function (optional)
-- ============================================================
DROP FUNCTION IF EXISTS create_updated_at_trigger(regclass);
