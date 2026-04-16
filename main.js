const obsidian = require("obsidian");

const DEFAULT_PROMPT_TEMPLATE =
  "As an academic expert with specialized knowledge in various fields, please provide a proficient and precise translation from {{sourceLanguage}} to {{targetLanguage}} of the academic text enclosed in 🔤. It is crucial to maintaining the original phrase or sentence and ensure accuracy while utilizing the appropriate language. The text is as follows: 🔤 {{text}} 🔤 Please provide the translated result without any additional explanation and remove 🔤.";

const DEFAULT_SETTINGS = {
  apiFormat: "gemini",
  apiKey: "",
  apiEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
  model: "gemini-3.1-flash-lite-preview",
  sourceLanguage: "English",
  targetLanguage: "简体中文",
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  temperature: 0.2,
  lowLatencyMode: true,
  maxOutputTokens: 1024,
  autoTranslateOnSelection: true,
  onlyTranslateLikelyEnglish: true,
  showOriginalText: false,
  minCharacters: 2,
  maxCharacters: 4000,
  selectionDebounceMs: 220,
  minRequestIntervalMs: 4000,
  sameSelectionCooldownMs: 15000,
  rateLimitCooldownMs: 30000
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSelectedText(text) {
  return String(text || "")
    .replace(/\u00ad/g, "")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getElementFromNode(node) {
  if (!node) {
    return null;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    return node;
  }

  return node.parentElement || null;
}

function getEventTargetElement(event) {
  if (!event) {
    return null;
  }

  return event.target instanceof Node ? getElementFromNode(event.target) : null;
}

class PdfGeminiTranslatePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.selectionTimer = null;
    this.viewportRaf = null;
    this.popupHovered = false;
    this.currentSelectionKey = "";
    this.dismissedSelectionKey = "";
    this.lastSelectionInfo = null;
    this.lastTranslation = "";
    this.translationCache = new Map();
    this.requestAttemptCache = new Map();
    this.nextAllowedRequestAt = 0;
    this.activeRequestId = 0;
    this.popupState = null;
    this.popup = null;
    this.popupEls = {};

    this.addSettingTab(new PdfGeminiTranslateSettingTab(this.app, this));

    this.addCommand({
      id: "translate-current-pdf-selection",
      name: "Translate current PDF selection",
      callback: async () => {
        await this.translateCurrentSelection({ force: true, manual: true });
      }
    });

    this.addCommand({
      id: "copy-latest-pdf-translation",
      name: "Copy latest PDF translation",
      callback: async () => {
        if (!this.lastTranslation) {
          new obsidian.Notice("还没有可复制的译文。");
          return;
        }

        await this.copyText(this.lastTranslation);
        new obsidian.Notice("译文已复制。");
      }
    });

    this.registerDomEvent(document, "selectionchange", () => {
      if (!this.getCurrentSelectionInfo()) {
        this.dismissedSelectionKey = "";
      }
    });

    this.registerDomEvent(
      document,
      "mouseup",
      (event) => {
        if (this.isEventInsidePopup(event)) {
          return;
        }

        this.scheduleSelectionHandling();
      },
      true
    );

    this.registerDomEvent(
      document,
      "keyup",
      (event) => {
        if (!event) {
          return;
        }

        if (this.isActiveElementInsidePopup()) {
          return;
        }

        const relevantKeys = [
          "Shift",
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown"
        ];

        if (relevantKeys.includes(event.key)) {
          this.scheduleSelectionHandling();
        }
      },
      true
    );

    this.registerDomEvent(
      document,
      "mousedown",
      (event) => {
        if (!this.popup) {
          return;
        }

        if (this.isEventInsidePopup(event)) {
          return;
        }

        const element = getEventTargetElement(event);
        if (element && element.closest(".pdf-container")) {
          return;
        }

        this.hidePopup();
      },
      true
    );

    this.registerDomEvent(
      document,
      "scroll",
      () => {
        this.handleViewportChange();
      },
      true
    );

    this.registerDomEvent(window, "resize", () => {
      this.handleViewportChange();
    });
  }

  onunload() {
    if (this.selectionTimer) {
      window.clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }

    if (this.viewportRaf) {
      window.cancelAnimationFrame(this.viewportRaf);
      this.viewportRaf = null;
    }

    this.destroyPopup();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isEventInsidePopup(event) {
    const element = getEventTargetElement(event);
    return Boolean(this.popup && element && this.popup.contains(element));
  }

  isActiveElementInsidePopup() {
    return Boolean(
      this.popup &&
        document.activeElement &&
        this.popup.contains(document.activeElement)
    );
  }

  scheduleSelectionHandling() {
    if (!this.settings.autoTranslateOnSelection) {
      return;
    }

    if (!this.getCurrentSelectionInfo()) {
      this.dismissedSelectionKey = "";
    }

    if (this.selectionTimer) {
      window.clearTimeout(this.selectionTimer);
    }

    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = null;
      this.translateCurrentSelection({ force: false, manual: false }).catch((error) => {
        console.error("[pdf-gemini-translate] selection translation failed", error);
      });
    }, this.settings.selectionDebounceMs);
  }

  handleViewportChange() {
    if (!this.popup) {
      return;
    }

    if (this.viewportRaf) {
      window.cancelAnimationFrame(this.viewportRaf);
    }

    this.viewportRaf = window.requestAnimationFrame(() => {
      this.viewportRaf = null;
      const info = this.getCurrentSelectionInfo();

      if (!info) {
        if (!this.isPopupInteractive()) {
          this.hidePopup();
        }
        return;
      }

      this.lastSelectionInfo = info;
      this.positionPopup(info.rect);
    });
  }

  isPopupInteractive() {
    return Boolean(
      this.popup &&
        (this.popupHovered ||
          (document.activeElement && this.popup.contains(document.activeElement)))
    );
  }

  isLikelyEnglish(text) {
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const words = (text.match(/[A-Za-z]{2,}/g) || []).length;
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;

    return letters >= Math.max(6, cjk * 2) && words >= 1;
  }

  getSelectionRect(selection, range) {
    if (!selection || !range) {
      return null;
    }

    const rects = Array.from(range.getClientRects ? range.getClientRects() : []);
    const rect = range.getBoundingClientRect();

    if (rect && rect.width > 0 && rect.height > 0) {
      return rect;
    }

    const firstRect = rects.find((item) => item.width > 0 && item.height > 0);
    return firstRect || null;
  }

  getCurrentSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const rawText = selection.toString();
    const normalizedText = normalizeSelectedText(rawText);

    if (!normalizedText) {
      return null;
    }

    if (normalizedText.length < this.settings.minCharacters) {
      return null;
    }

    if (normalizedText.length > this.settings.maxCharacters) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const anchorElement =
      getElementFromNode(range.commonAncestorContainer) ||
      getElementFromNode(selection.anchorNode);

    if (!anchorElement) {
      return null;
    }

    const textLayer = anchorElement.closest(".textLayer");
    const pdfContainer = anchorElement.closest(".pdf-container");

    if (!textLayer || !pdfContainer) {
      return null;
    }

    const rect = this.getSelectionRect(selection, range);
    if (!rect) {
      return null;
    }

    return {
      rawText,
      normalizedText,
      rect,
      textLayer,
      pdfContainer
    };
  }

  buildSelectionKey(info) {
    return [
      this.settings.model,
      this.settings.targetLanguage,
      this.settings.promptTemplate,
      info.normalizedText
    ].join("::");
  }

  buildDismissalKey(info) {
    const rect = info && info.rect ? info.rect : null;

    return [
      info ? info.normalizedText : "",
      rect ? Math.round(rect.left) : "",
      rect ? Math.round(rect.top) : "",
      rect ? Math.round(rect.width) : "",
      rect ? Math.round(rect.height) : ""
    ].join("::");
  }

  getRecentAttempt(selectionKey) {
    const attempt = this.requestAttemptCache.get(selectionKey);
    if (!attempt) {
      return null;
    }

    const ttlMs =
      typeof attempt.ttlMs === "number"
        ? attempt.ttlMs
        : this.settings.sameSelectionCooldownMs;

    if (Date.now() - attempt.at > ttlMs) {
      this.requestAttemptCache.delete(selectionKey);
      return null;
    }

    return attempt;
  }

  rememberAttempt(selectionKey, attempt) {
    this.requestAttemptCache.set(selectionKey, Object.assign({ at: Date.now() }, attempt));

    if (this.requestAttemptCache.size <= 200) {
      return;
    }

    const firstKey = this.requestAttemptCache.keys().next().value;
    if (firstKey) {
      this.requestAttemptCache.delete(firstKey);
    }
  }

  getRemainingGlobalCooldownMs() {
    return Math.max(0, this.nextAllowedRequestAt - Date.now());
  }

  async translateCurrentSelection(options) {
    const liveInfo = this.getCurrentSelectionInfo();
    const info =
      liveInfo ||
      options.infoOverride ||
      (this.isPopupInteractive() ? this.lastSelectionInfo : null);

    if (!info) {
      if (!this.isPopupInteractive()) {
        this.hidePopup();
      }

      if (options.manual) {
        new obsidian.Notice("请先在 Obsidian PDF 中选中一段文字。");
      }
      return;
    }

    if (
      this.settings.onlyTranslateLikelyEnglish &&
      !options.force &&
      !this.isLikelyEnglish(info.normalizedText)
    ) {
      if (!this.isPopupInteractive()) {
        this.hidePopup();
      }
      return;
    }

    if (!this.settings.apiKey.trim()) {
      this.lastSelectionInfo = info;
      this.lastTranslation = "";
      this.renderPopup({
        info,
        statusText: "请先在插件设置中填写 API Key。",
        translationText: "未配置 API Key。",
        isError: true
      });

      if (options.manual) {
        new obsidian.Notice("请先在插件设置中填写 API Key。");
      }
      return;
    }

    const selectionKey = this.buildSelectionKey(info);
    const dismissalKey = this.buildDismissalKey(info);
    this.lastSelectionInfo = info;

    if (this.dismissedSelectionKey && dismissalKey !== this.dismissedSelectionKey) {
      this.dismissedSelectionKey = "";
    }

    if (!options.force && dismissalKey === this.dismissedSelectionKey) {
      return;
    }

    const recentAttempt = this.getRecentAttempt(selectionKey);
    if (!options.force && recentAttempt) {
      if (recentAttempt.status === "error" && recentAttempt.message && this.popupState !== "done") {
        this.popupState = "error";
        this.lastTranslation = "";
        this.renderPopup({
          info,
          statusText: recentAttempt.message,
          translationText: recentAttempt.message,
          isError: true
        });
      } else if (recentAttempt.status === "success") {
        const cachedTranslation = this.translationCache.get(selectionKey);
        if (cachedTranslation) {
          this.lastTranslation = cachedTranslation;
          this.popupState = "done";
          this.renderPopup({
            info,
            statusText: "",
            translationText: cachedTranslation,
            isError: false
          });
        }
      }
      return;
    }

    if (
      !options.force &&
      selectionKey === this.currentSelectionKey &&
      (this.popupState === "loading" || this.popupState === "done")
    ) {
      this.positionPopup(info.rect);
      return;
    }

    this.currentSelectionKey = selectionKey;

    const cachedTranslation = this.translationCache.get(selectionKey);
    if (cachedTranslation && !options.force) {
      this.lastTranslation = cachedTranslation;
      this.popupState = "done";
      this.renderPopup({
        info,
        statusText: "",
        translationText: cachedTranslation,
        isError: false
      });
      return;
    }

    const remainingCooldownMs = this.getRemainingGlobalCooldownMs();
    if (remainingCooldownMs > 0) {
      const cooldownSeconds = Math.ceil(remainingCooldownMs / 1000);
      const cooldownMessage = `请求过于频繁，请 ${cooldownSeconds} 秒后再试。`;

      this.popupState = "error";
      this.lastTranslation = "";
      this.rememberAttempt(selectionKey, {
        status: "error",
        message: cooldownMessage,
        ttlMs: remainingCooldownMs
      });

      this.renderPopup({
        info,
        statusText: cooldownMessage,
        translationText: cooldownMessage,
        isError: true
      });
      return;
    }

    this.popupState = "loading";
    this.lastTranslation = "";
    this.renderPopup({
      info,
      statusText: `正在调用 ${this.settings.model}...`,
      translationText: "",
      isError: false,
      isLoading: true
    });

    const requestId = ++this.activeRequestId;
    this.nextAllowedRequestAt = Date.now() + this.settings.minRequestIntervalMs;

    try {
      const translation = await this.translateWithApi(info.normalizedText);
      if (requestId !== this.activeRequestId) {
        return;
      }

      this.popupState = "done";
      this.lastTranslation = translation;
      this.translationCache.set(selectionKey, translation);
      this.rememberAttempt(selectionKey, {
        status: "success"
      });

      if (this.translationCache.size > 200) {
        const firstKey = this.translationCache.keys().next().value;
        if (firstKey) {
          this.translationCache.delete(firstKey);
        }
      }

      const latestInfo = this.getCurrentSelectionInfo() || info;
      this.lastSelectionInfo = latestInfo;
      this.renderPopup({
        info: latestInfo,
        statusText: "",
        translationText: translation,
        isError: false
      });
    } catch (error) {
      if (requestId !== this.activeRequestId) {
        return;
      }

      const statusCode = this.getErrorStatusCode(error);
      const message = this.getErrorMessage(error);
      this.popupState = "error";
      this.lastTranslation = "";
      this.rememberAttempt(selectionKey, {
        status: "error",
        message
      });

      if (statusCode === 429) {
        this.nextAllowedRequestAt = Math.max(
          this.nextAllowedRequestAt,
          Date.now() + this.settings.rateLimitCooldownMs
        );
      }

      this.renderPopup({
        info,
        statusText: message,
        translationText: message,
        isError: true
      });

      if (options.manual) {
        new obsidian.Notice(`翻译失败：${message}`);
      }
    }
  }

  async translateWithApi(text) {
    if (this.settings.apiFormat === "openai") {
      return this.translateWithOpenAi(text);
    }
    return this.translateWithGemini(text);
  }

  buildOpenAiUrl() {
    const apiKey = this.settings.apiKey.trim();
    let endpoint = this.settings.apiEndpoint.trim();

    if (!apiKey) {
      throw new Error("API Key 不能为空。");
    }

    if (!endpoint) {
      throw new Error("API 接口地址不能为空。");
    }

    if (!endpoint.endsWith("/chat/completions")) {
      endpoint = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
    }

    return endpoint;
  }

  async translateWithOpenAi(text) {
    const url = this.buildOpenAiUrl();
    const requestText = this.buildGeminiRequestText(text);
    const apiKey = this.settings.apiKey.trim();
    const model = this.settings.model.trim() || "gpt-3.5-turbo";

    const body = {
      model: model,
      messages: [
        {
          role: "user",
          content: requestText
        }
      ],
      temperature: Number(this.settings.temperature) || 0,
      max_tokens: Number(this.settings.maxOutputTokens) || 1024
    };

    let response;

    try {
      response = await obsidian.requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw error;
    }

    const payload =
      response && typeof response.json === "object"
        ? response.json
        : response && typeof response.text === "string"
          ? JSON.parse(response.text)
          : null;

    if (!payload || typeof payload !== "object") {
      throw new Error("API 返回了无效响应。");
    }

    if (payload.error && payload.error.message) {
      throw new Error(payload.error.message);
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const resultText =
      choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content
        : "";

    if (resultText) {
      return resultText.trim();
    }

    throw new Error("API 返回了空结果。");
  }

  buildGeminiUrl() {
    const apiKey = this.settings.apiKey.trim();
    const model = this.settings.model.trim();
    let endpoint = this.settings.apiEndpoint.trim();

    if (!apiKey) {
      throw new Error("API Key 不能为空。");
    }

    if (!endpoint) {
      throw new Error("API 接口地址不能为空。");
    }

    endpoint = endpoint
      .replace(/:generateContent$/, "")
      .replace(/:streamGenerateContent$/, "")
      .replace(/\/+$/, "");

    if (!/\/models\//.test(endpoint)) {
      if (!model) {
        throw new Error("模型名称不能为空。");
      }
      endpoint = `${endpoint}/${encodeURIComponent(model)}`;
    }

    return `${endpoint}:generateContent?key=${encodeURIComponent(apiKey)}`;
  }

  renderPromptTemplate(text) {
    return this.settings.promptTemplate
      .replace(/\{\{\s*sourceLanguage\s*\}\}/g, this.settings.sourceLanguage)
      .replace(/\{\{\s*targetLanguage\s*\}\}/g, this.settings.targetLanguage)
      .replace(/\{\{\s*text\s*\}\}/g, text);
  }

  extractGeminiText(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("API 返回了无效响应。");
    }

    if (payload.error && payload.error.message) {
      throw new Error(payload.error.message);
    }

    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    const parts =
      candidate &&
      candidate.content &&
      Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];

    const text = parts
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();

    if (text) {
      return text;
    }

    if (payload.promptFeedback && payload.promptFeedback.blockReason) {
      throw new Error(`API 拒绝了该请求：${payload.promptFeedback.blockReason}`);
    }

    throw new Error("API 返回了空结果。");
  }

  buildGeminiRequestText(text) {
    const promptIncludesText = /\{\{\s*text\s*\}\}/.test(this.settings.promptTemplate);
    const renderedPrompt = this.renderPromptTemplate(text).trim();

    if (promptIncludesText) {
      return renderedPrompt;
    }

    return `${renderedPrompt}\n\nSource text:\n${text}`;
  }

  buildThinkingConfig() {
    if (!this.settings.lowLatencyMode) {
      return null;
    }

    const model = String(this.settings.model || "").trim().toLowerCase();

    if (model.startsWith("gemini-3")) {
      return {
        thinkingLevel: "minimal"
      };
    }

    if (model.startsWith("gemini-2.5")) {
      return {
        thinkingBudget: 0
      };
    }

    return null;
  }

  async translateWithGemini(text) {
    const url = this.buildGeminiUrl();
    const requestText = this.buildGeminiRequestText(text);
    const body = {
      generationConfig: {
        temperature: Number(this.settings.temperature) || 0,
        maxOutputTokens: Number(this.settings.maxOutputTokens) || 1024
      },
      contents: [
        {
          role: "user",
          parts: [{ text: requestText }]
        }
      ]
    };

    const thinkingConfig = this.buildThinkingConfig();
    if (thinkingConfig) {
      body.generationConfig.thinkingConfig = thinkingConfig;
    }

    let response;

    try {
      response = await obsidian.requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw error;
    }

    const payload =
      response && typeof response.json === "object"
        ? response.json
        : response && typeof response.text === "string"
          ? JSON.parse(response.text)
          : null;

    return this.extractGeminiText(payload);
  }

  getRawErrorMessage(error) {
    if (!error) {
      return "未知错误。";
    }

    if (typeof error === "string") {
      return error;
    }

    if (error.message) {
      return error.message;
    }

    return String(error);
  }

  getErrorStatusCode(error) {
    const rawMessage = this.getRawErrorMessage(error);
    const statusMatch =
      typeof rawMessage === "string"
        ? rawMessage.match(/\bstatus\s+(\d{3})\b/i)
        : null;

    return statusMatch ? Number.parseInt(statusMatch[1], 10) : null;
  }

  getErrorMessage(error) {
    const rawMessage = this.getRawErrorMessage(error);
    const statusCode = this.getErrorStatusCode(error);

    if (statusCode === 429) {
      return "API 请求被限流或当前配额已用完（429）。等一会再试，或检查 API 配额、Billing、代理网关限流设置。";
    }

    if (statusCode === 400) {
      return "API 请求格式不被当前接口接受（400）。通常是接口地址、模型、代理网关兼容性，或提示词内容过长导致。";
    }

    if (statusCode === 401) {
      return "API Key 无效或未填写（401）。";
    }

    if (statusCode === 403) {
      return "API 请求被拒绝（403）。请检查 API Key 权限、区域限制或代理配置。";
    }

    if (statusCode === 404) {
      return "API 接口地址或模型名称不对（404）。";
    }

    if (statusCode >= 500 && statusCode < 600) {
      return `API 服务暂时不可用（${statusCode}）。稍后再试。`;
    }

    if (/Failed to fetch|NetworkError|fetch/i.test(rawMessage)) {
      return "网络请求失败。请检查网络、代理或接口地址。";
    }

    return rawMessage || "未知错误。";
  }

  ensurePopup() {
    if (this.popup) {
      return this.popup;
    }
    if (!document.getElementById("pdf-glass-svg-defs")) {
      const div = document.createElement("div");
      div.innerHTML = `<svg><defs>
      <radialGradient id="pdf-glass-edge-mask" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="black" stopOpacity="0" />
        <stop offset="76%" stopColor="black" stopOpacity="0" />
        <stop offset="100%" stopColor="white" stopOpacity="1" />
      </radialGradient>
      <filter id="pdf-glass-filter" x="-35%" y="-35%" width="170%" height="170%" colorInterpolationFilters="sRGB">
        <feImage id="feimage" x="0" y="0" width="100%" height="100%" result="DISPLACEMENT_MAP" href="data:image/jpeg;base64,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cUAUAkEkziomgGgkoxZGgxZFQFQlYnQHRdPfj/10KCSCKESCNiVkViPSLpD0h6I0Q0I0A2IoBWBIJIBKBIJoJIJ2R2J0JWBUJ0JUB0XTv479dFZDYiglYigkhEgjZFQjRFQjRFQjQigFYigHYigmgEgmglYlYnQlQlYlQHQlQnQ9P/kf1yVkNiNCNkNiVENiNiViNEViNkVCVgKCViViViSCViSCVgdCViVCViVCdgVCVCdD1D+U/XBWQ2I0I2Q2JUQ2I0JWQ0I2JUQ2JUI2JUI2J0JWJWJWA2R0BWJ0I2JUJ2BUJUJ0P//EABkQAQEBAQEBAAAAAAAAAAAAAAECABEDEP/aAAgBAQABAgB1atWrVq1atWrVq1atWrVq1atWrVq1atWrVq+OrVq1atWrVq1atWrVq1atWrVq1atWrVq1atXxVppppppdWrVq1atWrVq1NNNNNNNNNNNPVWmmmmms6tWrVq1atWpppppppppppppp6q0000uc51atWrVq1ammmmmmmmmmmmmt1Vpppc5znVq1atWrVqaaaaaaaaaaaaaeqtNLnOc51atWrVq1ammmmmmmmmmmmmnqrS5znOc6tWrVq16222mmmmmmlVppp6tKuc5znOrVq1a9TbbbbTTTTTSq000qtLnOc5zq1atWrW0222200000qqqtKqrnOc5zq1atTbbbbbbbbTTTSqqqqqq5znOc6tTTTbbbbbbbbTTTSqqqqrlVznOctNNNtttttttttNNNNKqqqrqznKqrTTTTbbbbbbbbbTTTSqqqqrqznOc5aaaabbbbbbbbbaaaaVVVVVdWc5znVq1NNttttttttttNNKqqqqudWc5znVq16tbbbbbbbbbbTTSqqqq5XVnOc6tWrVrb1tttttttttNNKqqqqrWrK5VWmmm2230bbbbbbaaaXOc5zlVa1KuVVppptttt9G22222mmlzlVznK6tWVVWmmmm2222222222mlznOc5znLWppVVWmmm22222229bTWrOc5znOcq1qaaVpWmm222222229erVqznOc5znKtatStK0rTbTTbbbberXr1as5znOc5aVpppppWlabaabbbb1ta9WrVnOc5znU0rTTTTTTTTTbTTbbbTWvVq1as5znOdTTStNNNNNNNNNtNNtttN6tWvVq1ZznOrU00rTTTTTTTTTTTTTbTWvVq1atWrOc6tTTTStNNNNNNNNNNtNNtNa9WrVq1Z1Z1NNNNNK1q1NNNNNNNNNNNtNatWrVq1atWrU00000rWrVq1atWrVq1alaaa1atWrVq1NNNammmmla1atWrVq1aterVq16tWrVnVqa1NK1qaaaVX/xAAWEAADAAAAAAAAAAAAAAAAAAAhgJD/2gAIAQEAAz8AaExf/8QAGhEBAQEBAQEBAAAAAAAAAAAAAQISEQADEP/aAAgBAgEBAgDx48ePHjx48ePHjx48ePHjx48ePHjx48ePHj86IiIiIiInjx48ePHjx48IiIiIj0oooooooooRERER73ve60UUUUUUVrWiiiiiihERERER73ve97ooooorRWiiiiihKERERER73ve973RRRRWtFFFFFFCIiIiIiPe973ve60UUVrRRRRRRQiIlCIiI973ve973pRRWiiiiiiiiiiiiiiihEe973ve973RRWtFFFFFFFFFFFFFFFFFFa13ve973WitaKKKKKKKKKKKKKKKKKK1rWtd1rutFa1oooooooooooosssooorWta1rWta1rRRRRRRRRRRZZZZZZZZZWta1rWta1rRRRRRRRRZZZZZZZZZZZZe9a1rWta1rWitaKLLLLLLLLLLLLLLLLL3rWta1rWtFbLLLLLLLLLLLLLLLLLLLL3vWta1rWita1ssssssss+hZZZZZZZZe961rWta0Vre97LLLLLLLLLLLPoWWWWWXrWta1oorWta3ssss+hZZZZ9Cyyyyyyyyiita1orWta1ve9llllllllllllllllFFa0VorWta1ve9llllllllllllllllllFFFaK1rWta1rWiyyyyyyyyyyyyiiiiiiitFFa1rWta1oosoosssssoooosoooorRRRWta1rWta0UUUUUWUUUUUUUUUUUVoooorWta1rWtaKKKKKKmiiiiiiiiiiiiiiitd73ve61oSiiipoqaKKKKKKKKKK0UUUVrve973vREREZoSihEooooorRRRRWtd73ve9EREREREoSiiiiitFllllla73ve9ERERERESiiiiiitH0PoWWWWVrXe96IiIiMoiJRRRRRRWjwlFFllllFFd6IiIiIlCUUUUUUUUUePHjx48ePCIiIiIiIiUUUUUUUUUUUePHjx48ePHjx48ePHjx48IiUUUUUUJRRRX//xAAWEQADAAAAAAAAAAAAAAAAAAABYJD/2gAIAQIBAz8AtEV7/8QAFxEBAQEBAAAAAAAAAAAAAAAAAAECEP/aAAgBAwEBAgCtNNNNNNNNNNNNNNNNNNNNNNNNNNNNNcrTTTTTTTTTTTTTTTTTTTTTTTTTTTTTXKrTTTTTTTU000000000000000000001FVpppppqampqaaaaaaaaaaaaaaaaaaaa5Vaaaaampqampqammmmmmmmmmmlaaaaaaiq0001NTU1NTU1NTTTTTTTTTTSqqtNNNcqtNNSyzU1LNTU1NTTTTTTTTTSqqq001ytNLLLLNTU1NTU1NTbbbTTTTTSqqq001ytNLLLLLNTU1NTU3NttttNNNNNKqq001KrSyyyyyzU1NTU3Nzc02220000qqqqrSqqyyyyyzU1NTU3Nzc3NttttNNNKqqqqqqssssss1NTU3Nzc3NzbbbbTTTSqqqqqqrLLLLLNTU1Nzc3Nzc22220000qqqqqqqqssss1NTU3Nzc3NzbbbbbTTSqqqqqqqqqqzU1NTc3Nzc3Nzbc22000qqqqqqqqqqqtTU3Nzc3Nzc3NtzbTTSqqqqrKqqqqqtNNzc23Nzc3Nzc3NTU1KqqqrKqqqqqtNNNNttzc3Nzc3NzU1NLLLLLKqqqqqqqq0022223Nzc3NzU1NSyyyyyyqqqqqqqrTTbbbbc3Nzc3NTU1LLLLLLKsqqqqqqrTTTTbbbc3Nzc1NTUsssssssqqqqqqrTTTTTbbbTc3NTU1NTUsssssqqqqqqqq0000222023NTU1NTUsssssqqqqqqqq000000003NTU1NTU1LLLLLNKrTSqqqqtNNNNNNtNNTU1NSzUssss00qq0qqqqrTTTTTTTTTU1NTUs1LLLNNNKrTTTSqqq00000000001NTU1LNTU0000qtNNNKqqqtNNNNNNNNTU1NTUs1NNNNNKss1NNNK00qtK0000001NNTU0s000000qq000001NKrStNNNNK1NNNNStNNNNNKqtNNNNNNNK0000000rU0000rTTTTTSq00000rTTTTTTTTTTTTTTTTStNNNNKr/xAAUEQEAAAAAAAAAAAAAAAAAAACg/9oACAEDAQM/AAAf/9k=" preserveAspectRatio="xMidYMid slice" />
        <feColorMatrix in="DISPLACEMENT_MAP" type="matrix" values="0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0 0 0 1 0" result="EDGE_INTENSITY" />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="discrete" tableValues="0 0.1 1" />
        </feComponentTransfer>
        <feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL" />
        <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale="-25" xChannelSelector="R" yChannelSelector="B" result="RED_DISPLACED" />
        <feColorMatrix in="RED_DISPLACED" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="RED_CHANNEL" />
        <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale="-27.5" xChannelSelector="R" yChannelSelector="B" result="GREEN_DISPLACED" />
        <feColorMatrix in="GREEN_DISPLACED" type="matrix" values="0 0 0 0 0  1 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="GREEN_CHANNEL" />
        <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale="-30" xChannelSelector="R" yChannelSelector="B" result="BLUE_DISPLACED" />
        <feColorMatrix in="BLUE_DISPLACED" type="matrix" values="0 0 0 0 0  0 0 0 0 0  1 0 0 0 0  0 0 0 1 0" result="BLUE_CHANNEL" />
        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
        <feGaussianBlur in="RGB_COMBINED" stdDeviation="0.3" result="ABERRATED_BLURRED" />
        <feComposite in="ABERRATED_BLURRED" in2="EDGE_MASK" operator="in" result="EDGE_ABERRATION" />
        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
        <feComposite in="EDGE_ABERRATION" in2="CENTER_CLEAN" operator="over" />
      </filter></defs></svg>`;
      const el = div.firstElementChild;
      el.id = "pdf-glass-svg-defs";
      el.style.position = "absolute";
      el.style.width = "0";
      el.style.height = "0";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    }


    const popup = document.body.createDiv({ cls: "pdf-gemini-translate-popup" });
    const inner = popup.createDiv({ cls: "pdf-gemini-translate-popup-inner" });
    const header = inner.createDiv({ cls: "pdf-gemini-translate-popup-header" });
    const actions = header.createDiv({ cls: "pdf-gemini-translate-popup-actions" });

    const copyButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": "复制译文",
        type: "button"
      }
    });
    obsidian.setIcon(copyButton, "copy");

    const retryButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": "重新翻译",
        type: "button"
      }
    });
    obsidian.setIcon(retryButton, "refresh-cw");

    const closeButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": "关闭",
        type: "button"
      }
    });
    obsidian.setIcon(closeButton, "x");

    const statusEl = inner.createDiv({ cls: "pdf-gemini-translate-popup-status" });

    const originalCard = inner.createDiv({ cls: "pdf-gemini-translate-popup-card" });
    originalCard.createDiv({
      cls: "pdf-gemini-translate-popup-card-header",
      text: "Original"
    });
    const originalBody = originalCard.createDiv({
      cls: "pdf-gemini-translate-popup-card-body"
    });

    const translationCard = inner.createDiv({ cls: "pdf-gemini-translate-popup-card" });
    const translationHeader = translationCard.createDiv({
      cls: "pdf-gemini-translate-popup-card-header",
      text: this.settings.targetLanguage || "Translation"
    });
    const translationBody = translationCard.createDiv({
      cls: "pdf-gemini-translate-popup-card-body"
    });

    popup.addEventListener("mouseenter", () => {
      this.popupHovered = true;
    });

    popup.addEventListener("mouseleave", () => {
      this.popupHovered = false;
    });

    popup.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });

    popup.addEventListener("mouseup", (event) => {
      event.stopPropagation();
    });

    copyButton.addEventListener("click", async () => {
      if (!this.lastTranslation) {
        return;
      }

      await this.copyText(this.lastTranslation);
      new obsidian.Notice("译文已复制。");
    });

    retryButton.addEventListener("click", async () => {
      await this.translateCurrentSelection({
        force: true,
        manual: true,
        infoOverride: this.lastSelectionInfo
      });
    });

    closeButton.addEventListener("click", () => {
      this.hidePopup();
    });

    this.popup = popup;
    this.popupEls = {
      statusEl,
      copyButton,
      retryButton,
      closeButton,
      originalCard,
      originalBody,
      translationCard,
      translationHeader,
      translationBody
    };

    return popup;
  }

  destroyPopup() {
    if (this.popup) {
      this.popup.remove();
    }

    this.popup = null;
    this.popupEls = {};
    this.popupHovered = false;
  }

  hidePopup() {
    const info = this.getCurrentSelectionInfo() || this.lastSelectionInfo;
    if (info) {
      this.dismissedSelectionKey = this.buildDismissalKey(info);
    }

    this.activeRequestId += 1;
    this.popupState = null;
    this.currentSelectionKey = "";
    this.lastSelectionInfo = null;
    this.destroyPopup();
  }

  positionPopup(rect) {
    if (!this.popup || !rect) {
      return;
    }

    this.popup.style.left = "12px";
    this.popup.style.top = "12px";

    const popupRect = this.popup.getBoundingClientRect();
    const margin = 12;
    const left = clamp(
      rect.left + rect.width / 2 - popupRect.width / 2,
      margin,
      window.innerWidth - popupRect.width - margin
    );
    const topAbove = rect.top - popupRect.height - margin;
    const topBelow = rect.bottom + margin;
    const top =
      topAbove >= margin
        ? topAbove
        : clamp(topBelow, margin, window.innerHeight - popupRect.height - margin);

    this.popup.style.left = `${Math.round(left)}px`;
    this.popup.style.top = `${Math.round(top)}px`;
  }

  renderPopup(state) {
    this.ensurePopup();
    const {
      statusEl,
      copyButton,
      retryButton,
      originalCard,
      originalBody,
      translationHeader,
      translationBody
    } = this.popupEls;

    const statusText = state.statusText || "";
    statusEl.setText(statusText);
    statusEl.toggleClass("is-error", Boolean(state.isError));
    statusEl.style.display = statusText ? "" : "none";

    originalCard.style.display = this.settings.showOriginalText ? "" : "none";
    originalBody.empty();
    originalBody.removeClass("is-empty");

    if (this.settings.showOriginalText) {
      const originalText = state.info ? state.info.normalizedText : "";
      originalBody.setText(originalText || "");
      if (!originalText) {
        originalBody.addClass("is-empty");
        originalBody.setText("没有原文。");
      }
    }

    const showTranslationHeader = this.settings.showOriginalText;
    translationHeader.setText(this.settings.targetLanguage || "Translation");
    translationHeader.style.display = showTranslationHeader ? "" : "none";
    translationBody.empty();
    translationBody.removeClass("is-empty");
    translationBody.removeClass("is-loading");
    translationBody.removeClass("is-error");

    if (state.isLoading) {
      translationBody.addClass("is-loading");
      translationBody.setText("");
    } else if (state.isError) {
      translationBody.addClass("is-error");
      translationBody.setText(state.translationText || "翻译失败。");
    } else if (state.translationText) {
      translationBody.setText(state.translationText);
    } else {
      translationBody.addClass("is-empty");
      translationBody.setText("暂无译文。");
    }

    copyButton.disabled = !this.lastTranslation;
    retryButton.disabled = false;

    this.positionPopup(state.info ? state.info.rect : null);
  }

  async copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

class PdfGeminiTranslateSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const settings = this.plugin.settings;

    containerEl.empty();
    containerEl.createEl("h2", { text: "PDF Gemini Translate" });

    new obsidian.Setting(containerEl)
      .setName("API 协议格式")
      .setDesc("选择使用的 API 标准格式。默认 Gemini，若接第三方服务商 (如 OpenAI, DeepSeek, OneAPI代理)，请选 OpenAI 兼容。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gemini", "Gemini 格式")
          .addOption("openai", "OpenAI 兼容格式")
          .setValue(settings.apiFormat || "gemini")
          .onChange(async (value) => {
            settings.apiFormat = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("API Key")
      .setDesc("用于调用 API 的凭证。仅保存在本地。")
      .addText((text) =>
        text
          .setPlaceholder("API Key")
          .setValue(settings.apiKey)
          .onChange(async (value) => {
            settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("API 接口地址 (Base URL)")
      .setDesc("对于 Gemini 填 models 根地址，对于 OpenAI 格式填类似 https://api.openai.com/v1")
      .addText((text) =>
        text
          .setPlaceholder("https://generativelanguage.googleapis.com/v1beta/models")
          .setValue(settings.apiEndpoint)
          .onChange(async (value) => {
            settings.apiEndpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("模型名称 (Model)")
      .setDesc("对应您使用的模型名称，如 deepseek-chat, gpt-4o 等")
      .addText((text) =>
        text
          .setPlaceholder("gemini-3.1-flash-lite-preview")
          .setValue(settings.model)
          .onChange(async (value) => {
            settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("源语言")
      .setDesc("用于生成提示词，默认 English。")
      .addText((text) =>
        text.setValue(settings.sourceLanguage).onChange(async (value) => {
          settings.sourceLanguage = value.trim() || DEFAULT_SETTINGS.sourceLanguage;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("目标语言")
      .setDesc("默认翻译为简体中文。")
      .addText((text) =>
        text.setValue(settings.targetLanguage).onChange(async (value) => {
          settings.targetLanguage = value.trim() || DEFAULT_SETTINGS.targetLanguage;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("提示词模板")
      .setDesc("支持 {{sourceLanguage}}、{{targetLanguage}}、{{text}} 占位符。")
      .addTextArea((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.promptTemplate)
          .setValue(settings.promptTemplate)
          .onChange(async (value) => {
            settings.promptTemplate = value.trim() || DEFAULT_SETTINGS.promptTemplate;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName("Temperature")
      .setDesc("Gemini generationConfig.temperature。建议 0 到 1。")
      .addText((text) =>
        text.setValue(String(settings.temperature)).onChange(async (value) => {
          const parsed = Number.parseFloat(value);
          settings.temperature = Number.isFinite(parsed) ? clamp(parsed, 0, 2) : DEFAULT_SETTINGS.temperature;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("低延迟模式")
      .setDesc("优先极速输出。仅当开启 Gemini 协议且使用适用模型时生效。")
      .addToggle((toggle) =>
        toggle.setValue(settings.lowLatencyMode).onChange(async (value) => {
          settings.lowLatencyMode = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("最大输出 tokens")
      .setDesc("翻译场景一般不需要太大，设小一点通常会更快。")
      .addText((text) =>
        text.setValue(String(settings.maxOutputTokens)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.maxOutputTokens = Number.isFinite(parsed)
            ? clamp(parsed, 64, 8192)
            : DEFAULT_SETTINGS.maxOutputTokens;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("自动翻译 PDF 选区")
      .setDesc("在 PDF 文本层选中内容后自动触发翻译。")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoTranslateOnSelection).onChange(async (value) => {
          settings.autoTranslateOnSelection = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("仅自动翻译疑似英文选区")
      .setDesc("避免误触发中文或公式区域。命令面板手动翻译不受此限制。")
      .addToggle((toggle) =>
        toggle.setValue(settings.onlyTranslateLikelyEnglish).onChange(async (value) => {
          settings.onlyTranslateLikelyEnglish = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("显示原文")
      .setDesc("在悬浮翻译面板中显示选中的原文。")
      .addToggle((toggle) =>
        toggle.setValue(settings.showOriginalText).onChange(async (value) => {
          settings.showOriginalText = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("最小字符数")
      .setDesc("短于这个阈值的选区不会自动翻译。")
      .addText((text) =>
        text.setValue(String(settings.minCharacters)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.minCharacters = Number.isFinite(parsed) ? clamp(parsed, 1, 200) : DEFAULT_SETTINGS.minCharacters;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("最大字符数")
      .setDesc("长于这个阈值的选区不会自动翻译，避免一次请求过大。")
      .addText((text) =>
        text.setValue(String(settings.maxCharacters)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.maxCharacters = Number.isFinite(parsed) ? clamp(parsed, 100, 20000) : DEFAULT_SETTINGS.maxCharacters;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("选区防抖延迟")
      .setDesc("单位毫秒。拖拽选区完成后等待多久再请求 Gemini。")
      .addText((text) =>
        text.setValue(String(settings.selectionDebounceMs)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.selectionDebounceMs = Number.isFinite(parsed)
            ? clamp(parsed, 0, 3000)
            : DEFAULT_SETTINGS.selectionDebounceMs;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("最小请求间隔")
      .setDesc("单位毫秒。限制请求频率，建议保持在 4000 以上以避免被服务端限流（429）。")
      .addText((text) =>
        text.setValue(String(settings.minRequestIntervalMs)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.minRequestIntervalMs = Number.isFinite(parsed)
            ? clamp(parsed, 0, 60000)
            : DEFAULT_SETTINGS.minRequestIntervalMs;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("同一选区重试冷却")
      .setDesc("单位毫秒。避免同一段文字因为重复事件连续发请求。")
      .addText((text) =>
        text.setValue(String(settings.sameSelectionCooldownMs)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.sameSelectionCooldownMs = Number.isFinite(parsed)
            ? clamp(parsed, 0, 120000)
            : DEFAULT_SETTINGS.sameSelectionCooldownMs;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("429 冷却时间")
      .setDesc("单位毫秒。收到 429 后，在这段时间内不再继续打 Gemini。")
      .addText((text) =>
        text.setValue(String(settings.rateLimitCooldownMs)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.rateLimitCooldownMs = Number.isFinite(parsed)
            ? clamp(parsed, 0, 300000)
            : DEFAULT_SETTINGS.rateLimitCooldownMs;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createDiv({
      cls: "pdf-gemini-translate-setting-note",
      text:
        "当前版本只监听 Obsidian 桌面端 PDF 文本层中的选区，不会把结果写回 PDF 批注。若接代理网关，请先确认协议格式配置是否对应。"
    });
  }
}

module.exports = PdfGeminiTranslatePlugin;
