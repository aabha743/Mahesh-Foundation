"""Settings read from the environment that several modules share."""

import os

from dotenv import load_dotenv

# In production systemd passes .env to the process; locally this reads it (existing variables win).
load_dotenv()

IS_PRODUCTION = os.getenv("ENVIRONMENT", "development") == "production"
DEBUG_MODE = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes")
