# Changelog

## [0.8.0](https://github.com/zuohuadong/supacloud/compare/mcp-server-v0.7.0...mcp-server-v0.8.0) (2026-04-14)


### 🚀 Features

* **mcp:** add --file parameter for database query to handle multi-statement DDL with $$ delimiters ([f7922bb](https://github.com/zuohuadong/supacloud/commit/f7922bb340ca3eb44d2d4f9c4e3be43774ab3fe3))


### 📝 Documentation

* **mcp:** clarify --path for large Edge Functions and add frontend CLI examples ([ae06e21](https://github.com/zuohuadong/supacloud/commit/ae06e21eee95d08b05f535ec9b04e5d4d925db1a))

## [0.7.0](https://github.com/zuohuadong/supacloud/compare/mcp-server-v0.6.10...mcp-server-v0.7.0) (2026-04-14)


### 🚀 Features

* add MCP prompts, database schema resources, and secure table creation tool ([3b0e6c9](https://github.com/zuohuadong/supacloud/commit/3b0e6c98d472e8644f633eb76dc0f4c844444a7b))
* add OAuth providers, frontend hosting service and ECC SSL support ([f9f5b40](https://github.com/zuohuadong/supacloud/commit/f9f5b4076fe55f36a30ad7f8e247f6065eb57886))
* **api:** complete architecture hardening and Elysia schema validation implementation ([5d93b9a](https://github.com/zuohuadong/supacloud/commit/5d93b9ad1303efda36a3069e208096c5187f70ed))
* complete v3-v9 comprehensive compliance audit and bump version 0.0.1 ([8e3ac9f](https://github.com/zuohuadong/supacloud/commit/8e3ac9f5285611d2366bc0f652827befce822cde))
* **edge:** server-side Bun.build() bundling pipeline + multi-file bundle deploy ([4010992](https://github.com/zuohuadong/supacloud/commit/401099230b49a9ba08f5ef4cee6beab143d02b37))
* embed Streamable HTTP MCP endpoint with JWT token system, v0.5.5 ([9e7bc7e](https://github.com/zuohuadong/supacloud/commit/9e7bc7e294e5829bb53e39840d1928143ee68276))
* expand MCP server with 17 new tools (auth/storage/org/tasks), bump v0.5.4 ([0aece2a](https://github.com/zuohuadong/supacloud/commit/0aece2a0ab18b796f86357046fa478f16b5e708e))
* **management-api:** add web console tasks tracking & custom rate limits UI ([2f6baa1](https://github.com/zuohuadong/supacloud/commit/2f6baa120d9bf9c0ecbb6d20c7071eada5756595))
* **management-api:** implement Postgres LISTEN/NOTIFY queue worker for AI & MQTT events ([cca34a9](https://github.com/zuohuadong/supacloud/commit/cca34a955d33547292444e3fcf04b712f839f4f7))
* **mcp:** add --help flag with usage guide and configuration examples ([56f9dba](https://github.com/zuohuadong/supacloud/commit/56f9dba87225d32c814c61c73c54a39bf6816d52))
* **mcp:** add --local proxy proxy sniffing mode ([910711f](https://github.com/zuohuadong/supacloud/commit/910711fe0f4b7ac5be58489d0914125febb0594e))
* **mcp:** add contextual resources and advanced prompts (docs) ([e1de912](https://github.com/zuohuadong/supacloud/commit/e1de912b2cb7ff5f67ad95a9c2a27c621b493ef7))
* **mcp:** add frontend hosting tools and documentation ([d40b8fc](https://github.com/zuohuadong/supacloud/commit/d40b8fc130991a2fbab293bb442c03b9e040214c))
* **mcp:** add local CLI entrypoint for tool execution ([523425a](https://github.com/zuohuadong/supacloud/commit/523425a950b6c3f4ce6af2a99b6d6f7da3cc45c1))
* **mcp:** add storage upload via form-data + cron/diffing prompts ([4131a12](https://github.com/zuohuadong/supacloud/commit/4131a127dd2be68af914246f54cb6b713e4d02b9))
* **mcp:** add supreme capability pack (mock data, security audit, slow queries, edge functions) ([00c5b7c](https://github.com/zuohuadong/supacloud/commit/00c5b7c883cfd6a734e9aa9e769a1398b7c94b68))
* **mcp:** auto install git in setup_server_ssh, bump 0.2.2 ([9e759b6](https://github.com/zuohuadong/supacloud/commit/9e759b6a9d96efebd275321c65e9dd2316d9add6))
* **mcp:** complete parity with official supabase mcp (logs & multi-workflow prompts) ([ace68cd](https://github.com/zuohuadong/supacloud/commit/ace68cd946136a2d438b4114c504dd9273a48d15))
* **mcp:** default to thick-client mode running queries via api tunnel ([3eac0b5](https://github.com/zuohuadong/supacloud/commit/3eac0b507a4f35fb8cf6ed8f7cee463288b001dc))
* simplify frontend deployment with docker and mcp integration ([e2baff2](https://github.com/zuohuadong/supacloud/commit/e2baff230fd4f116610c9084b4a23444aa8768bf))
* simplify frontend deployment with docker and mcp integration ([61ace10](https://github.com/zuohuadong/supacloud/commit/61ace1046ebf0300c234a92a3d837cba79f1eb7a))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([def0c30](https://github.com/zuohuadong/supacloud/commit/def0c30fe63502a6717a760f19d98c0962ba76ab))


### 🐛 Bug Fixes

* **api:** natively support tenant JWTs (service_role_key) for authentication on backend ([b9a4910](https://github.com/zuohuadong/supacloud/commit/b9a49108d2c0b4e1131d878d283f685d1a49432b))
* **auth,infra:** 401 pre-flight and all-in-one local docker ([b7fb005](https://github.com/zuohuadong/supacloud/commit/b7fb00575e04cfec3a46df4209e214c6016f0bea))
* clean up mcp routes and release ([51fe8f9](https://github.com/zuohuadong/supacloud/commit/51fe8f9b00f8a5c7aa641e8d6b6022a6314e571c))
* fully fix project creation flow ([457f74c](https://github.com/zuohuadong/supacloud/commit/457f74c6c330d780b691bf3ce787b055606d2e3c))
* **mcp+install:** nginx backup before removal, fix install_supacloud git clone flow, bump 0.2.1 ([eb1e86a](https://github.com/zuohuadong/supacloud/commit/eb1e86acd2e3d9f7c8be0ae7af107cc3494080e7))
* **mcp:** prevent automatic hijacking of API_URL by tenant ENV, fixing Auth routing ([249bb50](https://github.com/zuohuadong/supacloud/commit/249bb50b4434dae350f27894844158e99dc027f4))
* **mcp:** remove repeated /mcp path from API_URL generation to prevent double slashes ([0376e42](https://github.com/zuohuadong/supacloud/commit/0376e42568c9823659b64040458a48a4f8ee9627))
* **mcp:** wrap all fetch calls in HttpTransport with try/catch to prevent unhandled rejection panics when API is unreachable ([ba4fd72](https://github.com/zuohuadong/supacloud/commit/ba4fd722d51b8b4462fd759943d873531f2ec8da))
* repair 2 failing getProjectHealth tests, fix providers page undefined variable, bump v0.5.2 ([c3883a5](https://github.com/zuohuadong/supacloud/commit/c3883a5a67e85340de081b130d8dd9940fc9322f))
* resolve post-merge issues in install flow ([2ddc863](https://github.com/zuohuadong/supacloud/commit/2ddc8630c0fdf3a1579e0c893d2c44520e67a007))


### 💅 Elegance & Refactoring

* **mcp:** consolidate 91 tools into 11 compound tools ([2efb4d5](https://github.com/zuohuadong/supacloud/commit/2efb4d57122affb37ee6004d328d2fec3ddf2cb5))


### 📝 Documentation

* **readme:** add supreme features and prompts guide ([6d8e73e](https://github.com/zuohuadong/supacloud/commit/6d8e73ea02f40211bbadd5167e2c0b577aa08a4c))


### 🔧 Miscellaneous Chores

* bump version (+0.0.1) for management-api and mcp-server ([16a7624](https://github.com/zuohuadong/supacloud/commit/16a76241fb7d7416ab9c25d331e471d6221fb9bc))
