import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { SessionsService } from '../../core/api/sessions.service';
import { ChatService } from '../../core/api/chat.service';

interface StatsOverview {
  sessions: { total: number; ready: number };
  handoffs: number;
  activeConversations: number;
  today: { in: number; out: number };
  series: { day: string; in: number; out: number }[];
  byClient: { clientId: number; name: string; in: number; out: number }[];
}

interface Bar {
  day: string;
  label: string;
  in: number;
  out: number;
  x: number;
  yIn: number; hIn: number;
  yOut: number; hOut: number;
}

// Paleta validada (dataviz): entrantes rosa, salientes morado.
// CVD ΔE 18.0 · normal 27.2 · contraste ≥3:1 sobre superficie clara — todos PASS.
export const CHART_IN = '#d4187e';
export const CHART_OUT = '#6D31ED';

const BAR_W = 16;
const BAR_STEP = 26;
const CHART_H = 150;
const GAP = 2; // separación entre segmentos apilados (hueco de superficie)

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [DatePipe, RouterLink],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly sessionsApi = inject(SessionsService);
  readonly chat = inject(ChatService);

  readonly overview = signal<StatsOverview | null>(null);
  readonly loading = signal(false);
  readonly hoverIdx = signal<number | null>(null);

  readonly colorIn = CHART_IN;
  readonly colorOut = CHART_OUT;
  readonly chartH = CHART_H;

  readonly unreadTotal = computed(() => {
    let total = 0;
    for (const n of this.chat.unreadByClient().values()) total += n;
    return total;
  });

  /** Serie de 14 días con huecos rellenos a cero. */
  readonly days = computed<{ day: string; in: number; out: number }[]>(() => {
    const byDay = new Map((this.overview()?.series || []).map((s) => [s.day, s]));
    const out: { day: string; in: number; out: number }[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      out.push({ day: key, in: row?.in || 0, out: row?.out || 0 });
    }
    return out;
  });

  readonly maxTotal = computed(() =>
    Math.max(1, ...this.days().map((d) => d.in + d.out)),
  );

  readonly bars = computed<Bar[]>(() => {
    const max = this.maxTotal();
    return this.days().map((d, i) => {
      const hIn = Math.round((d.in / max) * (CHART_H - 8));
      const hOut = Math.round((d.out / max) * (CHART_H - 8));
      return {
        day: d.day,
        label: d.day.slice(8, 10),
        in: d.in,
        out: d.out,
        x: i * BAR_STEP + (BAR_STEP - BAR_W) / 2,
        // entrantes abajo (ancladas a la base), salientes encima con hueco de 2px
        yIn: CHART_H - hIn,
        hIn,
        yOut: CHART_H - hIn - (hOut > 0 && hIn > 0 ? GAP : 0) - hOut,
        hOut,
      };
    });
  });

  readonly chartW = computed(() => this.days().length * BAR_STEP);

  ngOnInit() {
    this.load();
    this.chat.hydrate();
  }

  load() {
    this.loading.set(true);
    this.http.get<StatsOverview>('/api/stats/overview').subscribe({
      next: (o) => { this.overview.set(o); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }
}
