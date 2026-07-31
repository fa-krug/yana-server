import logging
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)


class AIClient:
    def __init__(self, settings):
        self.settings = settings
        self.provider = settings.active_ai_provider

    def _request_with_retry(self, url, headers, data, timeout):
        """POST request with retry on 429 (rate limit) using exponential backoff.

        Caps total retry time to avoid exceeding django-q task timeouts.
        """
        max_retries = getattr(self.settings, "ai_max_retries", 3)
        retry_delay = getattr(self.settings, "ai_retry_delay", 2)
        max_retry_time = getattr(self.settings, "ai_max_retry_time", 60)

        response = None
        last_exception = None
        start_time = time.monotonic()

        for attempt in range(1 + max_retries):
            response = requests.post(url, headers=headers, json=data, timeout=timeout)
            try:
                response.raise_for_status()
                return response
            except requests.exceptions.HTTPError as e:
                if response.status_code == 429 and attempt < max_retries:
                    wait = retry_delay * (2**attempt) if retry_delay else 0
                    elapsed = time.monotonic() - start_time
                    if wait and (elapsed + wait) > max_retry_time:
                        logger.warning(
                            f"Rate limited (429), but retrying would exceed "
                            f"time budget ({elapsed:.0f}s elapsed, {wait}s wait, "
                            f"{max_retry_time}s max). Giving up."
                        )
                        raise
                    logger.warning(
                        f"Rate limited (429), retrying in {wait}s "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    if wait:
                        time.sleep(wait)
                    last_exception = e
                    continue
                raise

        raise last_exception  # pragma: no cover

    @staticmethod
    def verify_api_connection(
        provider: str, api_key: str, model: str, api_url: Optional[str] = None
    ) -> bool:
        """
        Verify the API connection for a given provider with the specified credentials.
        Returns True if the connection is successful, False otherwise.
        """
        try:
            prompt = "Hello"
            if provider == "openai":
                return AIClient._verify_openai(api_key, model, api_url, prompt)
            elif provider == "anthropic":
                return AIClient._verify_anthropic(api_key, model, prompt)
            elif provider == "gemini":
                return AIClient._verify_gemini(api_key, model, prompt)
            else:
                logger.error(f"Unknown AI provider for verification: {provider}")
                return False
        except Exception as e:
            logger.error(f"Verification failed for {provider}: {e}")
            return False

    @staticmethod
    def _verify_openai(api_key: str, model: str, api_url: Optional[str], prompt: str) -> bool:
        if not api_key:
            return False

        base_url = api_url or "https://api.openai.com/v1"
        url = f"{base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 5,
        }

        response = requests.post(url, headers=headers, json=data, timeout=10)
        response.raise_for_status()
        return True

    @staticmethod
    def _verify_anthropic(api_key: str, model: str, prompt: str) -> bool:
        if not api_key:
            return False

        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 5,
        }

        response = requests.post(url, headers=headers, json=data, timeout=10)
        response.raise_for_status()
        return True

    @staticmethod
    def _verify_gemini(api_key: str, model: str, prompt: str) -> bool:
        if not api_key:
            return False

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        headers = {
            "Content-Type": "application/json",
        }

        data = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "maxOutputTokens": 5,
            },
        }

        response = requests.post(url, headers=headers, json=data, timeout=10)
        response.raise_for_status()
        return True

    def generate_response(
        self, prompt: str, json_mode: bool = False, json_schema: Optional[dict] = None
    ) -> Optional[str]:
        """
        Generate a response from the active AI provider.
        Returns the generated text or None if the call fails.

        Args:
            prompt: The input prompt
            json_mode: Whether to enforce JSON output (if supported)
            json_schema: Optional JSON schema for structured output (if supported)
        """
        if not self.provider:
            logger.warning("No AI provider selected.")
            return None

        try:
            if self.provider == "openai":
                return self._call_openai(prompt, json_mode)
            elif self.provider == "anthropic":
                return self._call_anthropic(prompt)
            elif self.provider == "gemini":
                return self._call_gemini(prompt, json_mode, json_schema)
            else:
                logger.error(f"Unknown AI provider: {self.provider}")
                return None
        except Exception as e:
            logger.warning(f"AI API call failed: {e}")
            return None

    def _call_openai(self, prompt: str, json_mode: bool = False) -> Optional[str]:
        if not self.settings.openai_enabled or not self.settings.openai_api_key:
            logger.warning("OpenAI is not enabled or configured.")
            return None

        url = f"{self.settings.openai_api_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.settings.openai_api_key}",
            "Content-Type": "application/json",
        }

        data = {
            "model": self.settings.openai_model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": self.settings.ai_temperature,
            "max_tokens": self.settings.ai_max_tokens,
        }

        if json_mode:
            data["response_format"] = {"type": "json_object"}

        try:
            response = self._request_with_retry(
                url, headers, data, timeout=self.settings.ai_request_timeout
            )
            result = response.json()
            return result["choices"][0]["message"]["content"]
        except requests.exceptions.RequestException as e:
            logger.warning(f"OpenAI Request Error: {e}")
            raise

    def _call_anthropic(self, prompt: str) -> Optional[str]:
        if not self.settings.anthropic_enabled or not self.settings.anthropic_api_key:
            logger.warning("Anthropic is not enabled or configured.")
            return None

        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": self.settings.anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

        data = {
            "model": self.settings.anthropic_model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": self.settings.ai_max_tokens,
            "temperature": self.settings.ai_temperature,
        }

        try:
            response = self._request_with_retry(
                url, headers, data, timeout=self.settings.ai_request_timeout
            )
            result = response.json()
            return result["content"][0]["text"]
        except requests.exceptions.RequestException as e:
            logger.warning(f"Anthropic Request Error: {e}")
            raise

    def _call_gemini(
        self, prompt: str, json_mode: bool = False, json_schema: Optional[dict] = None
    ) -> Optional[str]:
        if not self.settings.gemini_enabled or not self.settings.gemini_api_key:
            logger.warning("Gemini is not enabled or configured.")
            return None

        model = self.settings.gemini_model
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={self.settings.gemini_api_key}"
        headers = {
            "Content-Type": "application/json",
        }

        generation_config = {
            "temperature": self.settings.ai_temperature,
            "maxOutputTokens": self.settings.ai_max_tokens,
        }

        if json_mode:
            generation_config["responseMimeType"] = "application/json"
            if json_schema:
                generation_config["responseSchema"] = json_schema

        data = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": generation_config,
        }

        try:
            response = self._request_with_retry(
                url, headers, data, timeout=self.settings.ai_request_timeout
            )
            result = response.json()
            # Gemini response structure can vary, handle basic case
            try:
                return result["candidates"][0]["content"]["parts"][0]["text"]
            except (KeyError, IndexError) as err:
                logger.error(f"Unexpected Gemini response format: {result}")
                raise ValueError("Unexpected Gemini response format") from err
        except requests.exceptions.RequestException as e:
            logger.warning(f"Gemini Request Error: {e}")
            raise
