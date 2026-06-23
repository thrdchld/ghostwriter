from __future__ import annotations

import os
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent

# Load .env file explicitly
load_dotenv(ROOT_DIR / ".env")

def _data_dir() -> Path:
    configured = os.getenv("DATA_DIR")
    if configured:
        return Path(configured)
    persistent = Path("/data")
    if persistent.exists() and os.access(persistent, os.W_OK):
        return persistent / "ghostwaiter"
    return ROOT_DIR / "data"

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore"
    )

    data_dir: Path = Field(default_factory=_data_dir)
    hf_token: str = Field(default="", validation_alias="hf_token")
    app_password: str = Field(default="", validation_alias="app_password")
    session_secret: str = Field(default="", validation_alias="session_secret")
    github_token: str = Field(default="", validation_alias="github_token")
    github_repo: str = Field(default="", validation_alias="github_backup_repo")
    tavily_api_key: str = Field(default="", validation_alias="tavily_api_key")
    sync_debounce_seconds: int = Field(default=45, validation_alias="sync_debounce_seconds")
    
    ai_base_url: str = Field(default="https://thrdchld-9router.hf.space/v1", validation_alias="ai_base_url")
    supabase_url: str = Field(default="", validation_alias="supabase_url")
    supabase_key: str = Field(default="", validation_alias="supabase_key")

    def model_post_init(self, __context):
        # Handle fallback for session_secret
        if not self.session_secret:
            object.__setattr__(self, "session_secret", self.app_password or "dev-secret-change-me")
            
        # Strip quotes and spaces from env values to prevent DNS/validation errors
        for field in ("supabase_url", "supabase_key", "github_token", "github_repo", "ai_base_url"):
            val = getattr(self, field, "")
            if isinstance(val, str) and val:
                object.__setattr__(self, field, val.strip().strip("'\""))

settings = Settings()
