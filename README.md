# opencode-handoff-plugin

**auto-executor** — wtyczka [opencode](https://opencode.ai), która sekwencyjnie wykonuje
kroki (muszisz je zapewnić opisane i ponumerowane w osobnym pliku MarkDown) zadania z pliku JSON: **jeden krok = jedna nowa sesja czatu**. Gdy w trakcie kroku
zużycie kontekstu przekroczy próg, agent dostaje komunikat i wywołuje narzędzie
`handoff_save`, co uruchamia **nową konwersację w ramach tego samego kroku**
(prompt początkowy + „Co zrobiono dotychczas: {opis agenta}").

## Rozwój z udziałem AI

Projekt powstał przy intensywnym wsparciu AI: **zdecydowana większość kodu wtyczki
została napisana przez AI**. 
Wtyczka była testowana z modelem **GLM 5.3 Flash** (opencode 1.18.33).

## Wymagania

- opencode ≥ 1.18 (testowane na 1.18.33)
- brak zależności — wtyczka jest pojedynczym plikiem TypeScript (type-only import)

## Instalacja

Wtyczkę można zainstalować dla jednego projektu albo globalnie:

1. Skopiuj plik wtyczki z tego repozytorium:
   - per projekt:

     ```sh
     cp .opencode/plugins/auto-executor.ts <projekt>/.opencode/plugins/auto-executor.ts
     ```

   - globalnie:

     ```sh
     mkdir -p ~/.config/opencode/plugins
     cp .opencode/plugins/auto-executor.ts ~/.config/opencode/plugins/auto-executor.ts
     ```

2. Zrestartuj opencode (serwer/TUI).
3. Weryfikacja: komendy `/auto-exec` i `/stop-auto-execution` powinny być widoczne
   (w TUI po wpisaniu `/`), a log serwera powinien zawierać
   `zarejestrowano komendy /auto-exec, /stop-auto-execution; narzędzie handoff_save zawsze widoczne, próg: max_context w execute()`.

Plik `opencode.test.json` w tym repozytorium jest **wyłącznie testowy** (lokalne proxy
lemonade/openrouter) — **nie kopiuj go** podczas wdrożenia. Wtyczka ładuje się
automatycznie z `.opencode/plugins/`; nie wymaga żadnych wpisów w `opencode.json`.

## Użycie

```
/auto-exec <ścieżka-do-pliku.json>     # start sekwencji kroków
/stop-auto-execution                   # przerwanie bieżącego biegu
```

Komendy sterują wtyczką — nie są wysyłane do modelu (tura LLM komendy jest celowo anulowana).
Przykładowy plik konfiguracyjny: [`auto-exec.example.json`](auto-exec.example.json).

## Plik konfiguracyjny (JSON)

```json
{
  "prompt":      "tekst zadania, musi zawierać znacznik {step}",
  "from":        1,          // pierwszy krok (domyślnie 1)
  "to":          10,         // ostatni krok
  "max_context": 60000,      // próg kontekstu w tokenach (wymagany, > 0)
  "model":       "provider/model-id",  // opcjonalnie; domyślnie model z bieżącego czatu
  "agent":       "build",    // opcjonalnie; domyślnie agent z bieżącego czatu
  "tool_description": "opis narzędzia handoff_save dla agenta",  // opcjonalny
  "max_handoffs": 10,        // limit przekazów na krok (domyślnie 10)
  "max_instruction_attempts": 5,  // limit instrukcji handoff na sesję (domyślnie 5)
  "heartbeat_seconds": 45    // częstotliwość tętna w UI w sekundach (0 = wyłączone; domyślnie 45)
}
```

- `{step}` w promptach jest podmieniane numerem kroku.
- Bez pól `model`/`agent` wtyczka przejmuje **model i agenta wybrane w czacie**, z którego
  wystawiono komendę `/auto-exec` (wartości z JSON mają pierwszeństwo).
- Licznik kontekstu = `input + output + cache.read + cache.write` z ostatniej bezbłędnej
  wiadomości assistant; sprawdzany **po zakończonej turze** oraz **w trakcie tury**
  (zdarzenie `message.updated` niesie tokeny każdej zakończonej wiadomości assistant).

## Jak działa handoff

Narzędzie `handoff_save` jest **zawsze widoczne** — wtyczka ani go nie ukrywa
(`tools:false`), ani nie blokuje (`permission.deny`). Powody:

- flaga `tools` w treści promptu **nie zmienia zestawu narzędzi trwającej tury**
  (działa tylko dla nowej tury), więc ukrywanie uniemożliwiłoby przekazanie pracy
  w trakcie tury i w turach ręcznych,
- ukryte narzędzie byłoby niewidoczne również dla steeringu mid-turn.

Przed spontanicznym wywołaniem chroni **próg w `execute()`**: narzędzie odmawia,
dopóki kontekst sesji nie przekroczy `max_context` (porównywane są ostatnie znane
zużycie tokenów ze zdarzeń `message.updated` oraz snapshot sesji — tokeny bieżącej
wiadomości nie są jeszcze przypięte w momencie wykonywania narzędzia).

Próg jest pilnowany na dwóch poziomach:

1. **Po zakończonej turze** — jeśli kontekst > `max_context`, agent dostaje instrukcję
   („Kończy Ci się okno kontekstowe. Wywołaj narzędzie handoff_save…") i ma opisać stan
   pracy w argumencie `description`. Instrukcja jest **ponawiana** w kolejnych turach
   (limit: `max_instruction_attempts`, domyślnie 5 prób na sesję).
2. **W trakcie tury** — każda zakończona wiadomość assistant z tokenami > progu
   wstrzykuje **steering**: prompt sterujący wysłany do trwającej tury
   (`session.promptAsync` kolejkuję wiadomość do bieżącej tury) — agent widzi go
   natychmiast i może wykonać handoff bez kończenia tury. Steerowanie jest deduplikowane
   (jedno na wiadomość) i korzysta z tego samego licznika prób co ścieżka post-turn.
   Po wyczerpaniu `max_instruction_attempts` dalsze przekroczenia progu **przerywają turę**
   (`session.abort`) — to zapobiega super-długim sesjom, których nie da się uratować.

Po przerwanej turze (abort) pozostaje **ostatnia szansa**: jedna czysta tura z instrukcją
handoff („OSTATNIA SZANSA…"), w której handler mid-turn nie ingeruje — model w czystej
turze nie może ukryć się za „dokończę najpierw bieżącą pracę". Jeśli i to zawiedzie,
krok kończy się z ostrzeżeniem.

Wywołanie `handoff_save` tworzy nową sesję `[auto-exec] krok N/M — kontynuacja K`
z promptem początkowym + „Co zrobiono dotychczas: {description}". Turę kontynuacji
wtyczka odpala **bez czekania na jej zakończenie** (fire-and-forget) — koniec tury
obsługuje pętla monitorująca przez mechanizm waiterów, a monitoring progu obejmuje
sesję kontynuacji **od pierwszej wiadomości**. (Wcześniejsza wersja czekała w
`execute()` na całą turę kontynuacji, co na ten czas wyłączało monitoring mid-turn —
kontynuacja puchła bez steeringu, dopóki użytkownik ręcznie nie wymusił przekazu.)
Łańcuch kontynuacji jest ograniczony `max_handoffs`; po osiągnięciu któregokolwiek
limitu krok kończy się z ostrzeżeniem. `/stop-auto-execution` ustawia flagę stopu
i przerywa aktywną turę agenta (`session.abort`).

## Heartbeat (widoczność w UI)

Wtyczka raportuje w TUI, że żyje — brak komunikatów oznacza, że wtyczka umarła:

- **tętno okresowe** — co `heartbeat_seconds` (domyślnie 45 s) toast: bieżący krok,
  numer kontynuacji i czas od ostatniej aktywności; `0` wyłącza tętno,
- **odpalenie nowego taska** — toast przy tworzeniu sesji każdego kroku,
- **koniec tury agenta** — toast po każdej zakończonej turze (`session.idle`),
- **handoff** — toast przy tworzeniu sesji kontynuacji po wywołaniu `handoff_save`,
- **koniec / stop / błąd biegu** — toasty `success` / `warning` / `error`.

Wszystkie zdarzenia są też zapisywane w logu serwera (`client.app.log`,
serwis `auto-executor`) — tam można zweryfikować działanie, gdy TUI nie jest
podpięte (toasty trafiają wyłącznie do TUI).

Uwaga: `/auto-exec` **wymaga argumentu** — ścieżki do pliku JSON. Wywołanie bez
argumentu nic nie uruchamia (toast z użyciem + wpis w logu serwera).

## Uwagi

- Komendy działają w zwykłych czatach; historia wszystkich sesji kroków jest zachowana
  (tytuły sesji mają prefiks `[auto-exec]`).
- Model musi poprawnie wywoływać narzędzia. Modele ignorujące listę narzędzi (np. lokalny
  lemonade/Qwen3.8 w niektórych wersjach) mogą nie wykonać handoffu — to wada modelu,
  nie wtyczki.
- Testowy przebieg E2E (opencode 1.18.33, model GLM 5.3 Flash, degenerowany przypadek
  `max_context=1`) wykonał pełny łańcuch mid-turn: 2× steering w trakcie tury → handoff
  **przed końcem tury** → kontynuacja z przekazem → instrukcja post-turn → kolejne handoffy
  → limit `max_handoffs` → koniec kroku. Wariant z wyczerpaniem prób przeszedł ścieżkę
  abort → „ostatnia szansa".

## Testy i development

- `opencode.test.json` — konfiguracja testowa (lokalne proxy lemonade/openrouter).
  Testowy serwer opencode należy odpalać z katalogu zawierającego `.opencode/plugins/`
  i ten config (`opencode serve` instancjuje się w katalogu bieżącym).
- Typecheck (potrzebne typy `@opencode-ai/plugin` — wtyczka w runtime ich nie wymaga):

  ```sh
  cd .opencode
  npm i @opencode-ai/plugin
  npx -y -p typescript tsc --noEmit --skipLibCheck --strict --target es2022 \
    --module esnext --moduleResolution bundler plugins/auto-executor.ts
  ```

  Baseline zawiera ~11 „szumowych" błędów (TS2554 — dwuargumentowe wywołania klienta,
  TS7006/7031 — implicit any, TS2322 — Plugin non-async, TS2591 — brak @types/node);
  kod działa poprawnie pod bunem.

## Licencja

[MIT](LICENSE)