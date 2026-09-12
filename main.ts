import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

interface FileCacheEntry {
  lastScanned: number;   // timestamp последнего скана этого файла (для оптимизации полного скана)
  copied: string[];      // тексты задач, уже скопированные из этого файла (чтобы не дублировать)
}

interface TaskSorterSettings {
  lifeFile: string;      // куда копируются задачи БЕЗ даты
  datedFile: string;     // куда копируются задачи С датой
  sortHeading: string;   // название лейна-приёмника в обоих файлах
  excludePaths: string;  // папки/файлы через запятую, которые не сканируем
  topLevelOnly: boolean; // сортировать только задачи верхнего уровня (без отступа)
  sortInsertedTasks: boolean; // сортировать содержимое лейна Sort после вставки
  scanCache: Record<string, FileCacheEntry>; // path -> данные последнего скана
}

const DEFAULT_SETTINGS: TaskSorterSettings = {
  lifeFile: "Жизнь.md",
  datedFile: "Датируемые.md",
  sortHeading: "## Sort",
  excludePaths: "",
  topLevelOnly: true,
  sortInsertedTasks: true,
  scanCache: {},
};

// Эмодзи-маркеры дат/повторов, которые использует плагин Tasks
const DATE_MARKERS = /[📅⏳🛫🔁➕]/u;

// Незавершённая задача верхнего уровня: "- [ ] текст"
const TASK_LINE_RE = /^(\s*)-\s\[ \]\s+(.*)$/;

interface CollectedTask {
  text: string;      // "- [ ] ..." строка
  sourcePath: string;
}

interface ScanCollection {
  dated: CollectedTask[];
  life: CollectedTask[];
}

interface TargetValidation {
  ok: boolean;
  reason?: string;
}

type SortMode = "date" | "alpha";

// Извлекает первую дату вида YYYY-MM-DD из текста задачи (после 📅, ⏳ или 🛫), для сортировки.
// Возвращает null, если дата не найдена (например, только 🔁 без явной даты) — такие задачи
// уходят в конец списка при сортировке.
function extractSortDate(text: string): string | null {
  const m = text.match(/[📅⏳🛫]\s*(\d{4}-\d{2}-\d{2})/u);
  return m ? m[1] : null;
}

// Убирает "- [ ] " в начале для сравнения текста при алфавитной сортировке
function stripCheckbox(text: string): string {
  return text.replace(/^-\s\[ \]\s*/, "").trim();
}

function sortLaneContent(lines: string[], mode: SortMode): string[] {
  const withIndex = lines.map((line, idx) => ({ line, idx }));

  withIndex.sort((a, b) => {
    if (mode === "date") {
      const da = extractSortDate(a.line);
      const db = extractSortDate(b.line);
      if (da && db) return da.localeCompare(db);
      if (da && !db) return -1; // с датой — выше задач без даты
      if (!da && db) return 1;
      return a.idx - b.idx; // обе без даты — сохраняем исходный порядок
    } else {
      const ta = stripCheckbox(a.line);
      const tb = stripCheckbox(b.line);
      const cmp = ta.localeCompare(tb, "ru");
      return cmp !== 0 ? cmp : a.idx - b.idx;
    }
  });

  return withIndex.map((w) => w.line);
}

export default class TaskSorterPlugin extends Plugin {
  settings: TaskSorterSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "sort-tasks-into-boards",
      name: "Разобрать задачи по доскам (полный скан, с кэшем)",
      callback: () => this.sortTasksFullScan(),
    });

    this.addCommand({
      id: "sort-tasks-reset-cache",
      name: "Сбросить кэш сканирования",
      callback: () => this.resetScanCache(),
    });

    this.addCommand({
      id: "sort-tasks-cleanup-cache",
      name: "Очистить кэш от удалённых файлов",
      callback: () => this.cleanupCache(),
    });

    this.addRibbonIcon("list-checks", "Разобрать задачи текущего файла", () => {
      this.sortTasksActiveFile();
    });

    this.addSettingTab(new TaskSorterSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.scanCache) this.settings.scanCache = {};
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private getExcludeList(): string[] {
    return this.settings.excludePaths
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private isTargetBoard(path: string): boolean {
    return path === this.settings.lifeFile || path === this.settings.datedFile;
  }

  private isExcluded(file: TFile, excludeList: string[]): boolean {
    if (this.isTargetBoard(file.path)) return true;
    return excludeList.some(
      (ex) => file.path === ex || file.path.startsWith(ex.endsWith("/") ? ex : ex + "/")
    );
  }

  // ---------- Предварительная проверка: файл существует и заголовок-лейн на месте ----------
  private validateTarget(filePath: string): TargetValidation {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return {
        ok: false,
        reason: `файл "${filePath}" не найден. Проверьте путь в настройках плагина (точный путь от корня хранилища, с учётом регистра, например "Папка/Файл.md").`,
      };
    }
    return { ok: true };
  }

  private async validateTargetHeading(filePath: string): Promise<TargetValidation> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return { ok: false, reason: `файл "${filePath}" не найден.` };
    }
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const headingIdx = lines.findIndex((l) => l.trim() === this.settings.sortHeading.trim());
    if (headingIdx === -1) {
      return {
        ok: false,
        reason: `в файле "${filePath}" не найден заголовок лейна "${this.settings.sortHeading}".`,
      };
    }
    return { ok: true };
  }

  // ---------- Убирает из кэша записи о файлах, которых больше нет в хранилище ----------
  private pruneMissingFilesFromCache(): number {
    let removed = 0;
    for (const path of Object.keys(this.settings.scanCache)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        delete this.settings.scanCache[path];
        removed++;
      }
    }
    return removed;
  }

  async cleanupCache() {
    const removed = this.pruneMissingFilesFromCache();
    await this.saveSettings();
    new Notice(
      removed > 0
        ? `Task Sorter: из кэша удалено записей о ${removed} несуществующих файлах.`
        : "Task Sorter: в кэше нет записей об удалённых файлах, чистить нечего."
    );
  }

  // ---------- Режим 1: полный скан хранилища, пропускает файлы, не менявшиеся с прошлого скана ----------
  async sortTasksFullScan() {
    const prunedCount = this.pruneMissingFilesFromCache();
    if (prunedCount > 0) {
      await this.saveSettings();
    }

    const excludeList = this.getExcludeList();
    const allFiles = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f, excludeList));

    const toScan = allFiles.filter((f) => {
      const cached = this.settings.scanCache[f.path];
      return !cached || f.stat.mtime > cached.lastScanned;
    });

    const skipped = allFiles.length - toScan.length;
    await this.runSort(toScan, `Просканировано файлов: ${toScan.length}, пропущено кэшем: ${skipped}`);
  }

  // ---------- Режим 2: только текущий/открытый файл, кэш дедупликации всё равно участвует ----------
  async sortTasksActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("Task Sorter: нет открытого файла.");
      return;
    }
    if (this.isTargetBoard(activeFile.path)) {
      new Notice("Task Sorter: нельзя сканировать сами доски-приёмники.");
      return;
    }

    await this.runSort([activeFile], `Файл: «${activeFile.basename}»`);
  }

  async resetScanCache() {
    this.settings.scanCache = {};
    await this.saveSettings();
    new Notice(
      "Task Sorter: кэш очищен. При следующем скане все файлы будут проверены заново, " +
        "и уже скопированные ранее задачи (если их текст не менялся) могут быть скопированы повторно."
    );
  }

  // ---------- Главный безопасный конвейер: копирование в доски, источник не меняется ----------
  private async runSort(files: TFile[], contextLabel: string) {
    // 1. Проверяем, что оба целевых файла и заголовок-лейн существуют, ДО того как что-либо делать
    const lifeCheck = this.validateTarget(this.settings.lifeFile);
    if (!lifeCheck.ok) {
      new Notice(`Task Sorter: остановлено.\nПричина: ${lifeCheck.reason}`, 10000);
      return;
    }
    const datedCheck = this.validateTarget(this.settings.datedFile);
    if (!datedCheck.ok) {
      new Notice(`Task Sorter: остановлено.\nПричина: ${datedCheck.reason}`, 10000);
      return;
    }
    const lifeHeadingCheck = await this.validateTargetHeading(this.settings.lifeFile);
    if (!lifeHeadingCheck.ok) {
      new Notice(`Task Sorter: остановлено.\nПричина: ${lifeHeadingCheck.reason}`, 10000);
      return;
    }
    const datedHeadingCheck = await this.validateTargetHeading(this.settings.datedFile);
    if (!datedHeadingCheck.ok) {
      new Notice(`Task Sorter: остановлено.\nПричина: ${datedHeadingCheck.reason}`, 10000);
      return;
    }

    // 2. Читаем и парсим исходники, пропуская задачи, которые уже копировались раньше
    const collection = await this.collectTasks(files);

    if (collection.dated.length === 0 && collection.life.length === 0) {
      new Notice(`Task Sorter: новых задач не найдено. ${contextLabel}`);
      this.touchCacheTimestamps(files);
      await this.saveSettings();
      return;
    }

    // 3. Копируем задачи в целевые доски (с проверкой на дубли внутри appendToSort). Источники пока не трогаем.
    let lifeResult = { added: [] as string[], duplicates: [] as string[] };
    let datedResult = { added: [] as string[], duplicates: [] as string[] };
    try {
      if (collection.life.length > 0) {
        lifeResult = await this.appendToSort(
          this.settings.lifeFile,
          collection.life.map((t) => t.text),
          "alpha"
        );
      }
      if (collection.dated.length > 0) {
        datedResult = await this.appendToSort(
          this.settings.datedFile,
          collection.dated.map((t) => t.text),
          "date"
        );
      }
    } catch (e) {
      new Notice(`Task Sorter: ошибка при записи в доски, ничего не скопировано.\n${(e as Error).message}`, 10000);
      return;
    }

    // 4. Помечаем ВСЕ найденные задачи (и добавленные, и оказавшиеся дублями) как уже
    //    скопированные для соответствующих исходных файлов — дубли тоже не нужно пытаться копировать снова
    this.recordCopied(collection);
    this.touchCacheTimestamps(files);
    await this.saveSettings();

    const totalAdded = lifeResult.added.length + datedResult.added.length;
    const totalDuplicates = lifeResult.duplicates.length + datedResult.duplicates.length;

    if (totalAdded === 0 && totalDuplicates > 0) {
      new Notice(
        `Task Sorter: найдено ${totalDuplicates} задач(и), но все они дубликаты уже существующих в досках — ничего не добавлено. ${contextLabel}`
      );
      return;
    }

    let msg =
      `Task Sorter: скопировано ${totalAdded} задач(и) (источники не изменены). ${contextLabel}\n` +
      `Без даты → ${this.settings.lifeFile}: ${lifeResult.added.length}\n` +
      `С датой → ${this.settings.datedFile}: ${datedResult.added.length}`;
    if (totalDuplicates > 0) {
      msg += `\nПропущено как дубликаты (уже есть в доске): ${totalDuplicates}`;
    }
    new Notice(msg);
  }

  private touchCacheTimestamps(files: TFile[]) {
    const now = Date.now();
    for (const f of files) {
      const entry = this.settings.scanCache[f.path] ?? { lastScanned: 0, copied: [] };
      entry.lastScanned = now;
      this.settings.scanCache[f.path] = entry;
    }
  }

  private recordCopied(collection: ScanCollection) {
    const all = [...collection.life, ...collection.dated];
    for (const task of all) {
      const entry = this.settings.scanCache[task.sourcePath] ?? { lastScanned: 0, copied: [] };
      if (!entry.copied.includes(task.text)) {
        entry.copied.push(task.text);
      }
      this.settings.scanCache[task.sourcePath] = entry;
    }
  }

  // ---------- Разбор задач из файлов БЕЗ записи на диск, с пропуском уже скопированных ----------
  private async collectTasks(files: TFile[]): Promise<ScanCollection> {
    const collectedDated: CollectedTask[] = [];
    const collectedLife: CollectedTask[] = [];

    for (const file of files) {
      const alreadyCopied = new Set(this.settings.scanCache[file.path]?.copied ?? []);
      const original = await this.app.vault.read(file);
      const lines = original.split("\n");
      let inFence = false;

      for (const line of lines) {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;

        const match = line.match(TASK_LINE_RE);
        if (!match) continue;

        const indent = match[1];
        const text = match[2];
        const isTopLevel = indent.length === 0;
        if (this.settings.topLevelOnly && !isTopLevel) continue;

        const cleanLine = `- [ ] ${text}`;
        if (alreadyCopied.has(cleanLine)) continue; // уже копировали раньше — пропускаем

        if (DATE_MARKERS.test(text)) {
          collectedDated.push({ text: cleanLine, sourcePath: file.path });
        } else {
          collectedLife.push({ text: cleanLine, sourcePath: file.path });
        }
      }
    }

    return { dated: collectedDated, life: collectedLife };
  }

  // ---------- Запись новых задач в лейн-приёмник целевого файла, с проверкой на дубли ----------
  // Дубль = строка с точно таким же текстом задачи, уже существующая ГДЕ УГОДНО в целевом файле
  // (не только в лейне Sort) — это подстраховка на случай сброса кэша, ручного дублирования
  // или одинаковой задачи в двух разных заметках-источниках.
  private async appendToSort(
    filePath: string,
    newTasks: string[],
    sortMode: SortMode
  ): Promise<{ added: string[]; duplicates: string[] }> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`файл "${filePath}" не найден.`);
    }

    const content = await this.app.vault.read(file);
    const lines = content.split("\n");

    const headingIdx = lines.findIndex((l) => l.trim() === this.settings.sortHeading.trim());
    if (headingIdx === -1) {
      throw new Error(`заголовок "${this.settings.sortHeading}" не найден в "${filePath}".`);
    }

    // Убираем дубли внутри самого входного списка (например, одна и та же задача найдена в двух источниках)
    const seenInBatch = new Set<string>();
    const uniqueIncoming = newTasks.filter((t) => {
      if (seenInBatch.has(t)) return false;
      seenInBatch.add(t);
      return true;
    });

    // Строки, уже существующие в файле-приёмнике целиком (не только в лейне Sort)
    const existingLines = new Set(lines.map((l) => l.trim()));

    const added: string[] = [];
    const duplicates: string[] = [];
    for (const task of uniqueIncoming) {
      if (existingLines.has(task.trim())) {
        duplicates.push(task);
      } else {
        added.push(task);
      }
    }

    if (added.length === 0) {
      // Всё, что пришло, уже есть в файле — писать нечего
      return { added, duplicates };
    }

    // Находим конец лейна: следующая строка, начинающаяся с "## "
    let laneEnd = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        laneEnd = i;
        break;
      }
    }

    const laneLines = lines.slice(headingIdx + 1, laneEnd);
    // Убираем пустые строки в конце лейна, оставляя существующие задачи как есть
    while (laneLines.length > 0 && laneLines[laneLines.length - 1].trim() === "") {
      laneLines.pop();
    }

    let newLaneContent = [...laneLines, ...added];
    if (this.settings.sortInsertedTasks) {
      newLaneContent = sortLaneContent(newLaneContent, sortMode);
    }

    const before = lines.slice(0, headingIdx + 1);
    const after = lines.slice(laneEnd);

    // Формат: заголовок, пустая строка, задачи, пустая строка перед следующим лейном
    const rebuilt = [
      ...before,
      "",
      ...newLaneContent,
      "",
      ...after,
    ];

    await this.app.vault.modify(file, rebuilt.join("\n"));
    return { added, duplicates };
  }
}

class TaskSorterSettingTab extends PluginSettingTab {
  plugin: TaskSorterPlugin;

  constructor(app: App, plugin: TaskSorterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Kanban Task Sorter — настройки" });

    containerEl.createEl("p", {
      text:
        "Плагин только копирует задачи в доски — исходные заметки не изменяются. " +
        "Перед добавлением проверяется, нет ли уже такой же строки в целевом файле — дубликаты пропускаются.",
    });

    new Setting(containerEl)
      .setName("Файл без даты (Sort)")
      .setDesc('Путь к файлу от корня хранилища, например "Жизнь.md" или "Канбан/Жизнь.md". Без кавычек.')
      .addText((text) =>
        text
          .setPlaceholder("Жизнь.md")
          .setValue(this.plugin.settings.lifeFile)
          .onChange(async (value) => {
            this.plugin.settings.lifeFile = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Файл с датой (Sort)")
      .setDesc('Путь к файлу от корня хранилища, например "Датируемые.md" или "Канбан/Датируемые.md". Задачи с 📅 ⏳ 🛫 🔁 попадают сюда.')
      .addText((text) =>
        text
          .setPlaceholder("Датируемые.md")
          .setValue(this.plugin.settings.datedFile)
          .onChange(async (value) => {
            this.plugin.settings.datedFile = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Название лейна-приёмника")
      .setDesc('Заголовок лейна в обоих файлах, куда добавляются задачи. По умолчанию "## Sort".')
      .addText((text) =>
        text
          .setPlaceholder("## Sort")
          .setValue(this.plugin.settings.sortHeading)
          .onChange(async (value) => {
            this.plugin.settings.sortHeading = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Исключить пути")
      .setDesc("Папки или файлы через запятую, которые не нужно сканировать при полном скане (например: Templates, Архив/старое.md). На скан текущего файла (иконка на ленте) не влияет.")
      .addText((text) =>
        text
          .setPlaceholder("Templates, Архив")
          .setValue(this.plugin.settings.excludePaths)
          .onChange(async (value) => {
            this.plugin.settings.excludePaths = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Только задачи верхнего уровня")
      .setDesc("Если включено, вложенные подзадачи (с отступом) не копируются, чтобы не ломать иерархию.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.topLevelOnly).onChange(async (value) => {
          this.plugin.settings.topLevelOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Сортировать лейн после вставки")
      .setDesc(
        "Датируемые задачи сортируются по дате (📅/⏳/🛫, ближайшие сверху, без даты — в конец). " +
          "Задачи без даты сортируются по алфавиту. Если выключить — новые задачи просто добавляются в конец списка."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sortInsertedTasks).onChange(async (value) => {
          this.plugin.settings.sortInsertedTasks = value;
          await this.plugin.saveSettings();
        })
      );

    const totalCopied = Object.values(this.plugin.settings.scanCache).reduce(
      (sum, e) => sum + e.copied.length,
      0
    );

    new Setting(containerEl)
      .setName("Кэш сканирования и дедупликации")
      .setDesc(
        `Плагин запоминает, какие задачи уже скопированы из каждого файла, чтобы не дублировать их при повторном скане. ` +
          `Сейчас в кэше: ${Object.keys(this.plugin.settings.scanCache).length} файл(ов), ${totalCopied} задач(и) отмечено как скопированные. ` +
          `Записи об удалённых файлах чистятся автоматически при каждом полном скане. ` +
          `Сброс приведёт к повторному копированию всех подходящих задач при следующем скане.`
      )
      .addButton((btn) =>
        btn.setButtonText("Очистить удалённые файлы").onClick(async () => {
          await this.plugin.cleanupCache();
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Сбросить кэш").onClick(async () => {
          await this.plugin.resetScanCache();
          this.display();
        })
      );
  }
}
