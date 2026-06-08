from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# server-py/ directory (two parents up from this file: src/dana/config.py -> src -> server-py)
SERVER_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(SERVER_DIR / ".env"), extra="ignore")

    proxy_base_url: str = "http://127.0.0.1:8317"
    proxy_api_key: str = "sk-dummy"
    management_secret: str = ""
    searxng_url: str = "http://localhost:8080"
    firecrawl_url: str = ""
    port: int = 3001

    # Dev defaults to server-py/data — a COPY of the live dana.db. Override DATA_DIR only
    # when you intend to share the live database (requires write coordination with the TS backend).
    data_dir: Path = SERVER_DIR / "data"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "dana.db"


settings = Settings()
