-- Anonymous daily event totals only. No account/session IDs, IPs, URLs, query
-- strings, referrers, user agents, or precise event timestamps are recorded here.
CREATE TABLE public_analytics_daily (
  event_type TEXT NOT NULL CHECK (event_type IN ('PAGE_VIEW','SIGNUP_STARTED','CTA_CLICK','APP_STORE_CLICK','PLAY_STORE_CLICK','LOGIN_CLICK')),
  path TEXT NOT NULL CHECK (path IN ('/','/about','/contact','/pricing','/login','/register','/download','/how-it-works','/evidence-integrity','/reviewers','/integrations','/platform-api','/sellers','/buyers','/security','/proof','/proof-anywhere','/privacy','/terms')),
  device_class TEXT NOT NULL CHECK (device_class IN ('desktop','mobile','tablet','unknown')),
  day DATE NOT NULL,
  event_count BIGINT NOT NULL CHECK (event_count BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(event_type,path,device_class,day)
);
CREATE INDEX public_analytics_daily_day ON public_analytics_daily(day);
