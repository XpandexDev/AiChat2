import { Component, HostListener, OnDestroy, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { ClientAuthService } from '../../core/auth/client-auth.service';
import { ClientRealtimeService } from '../../core/api/client-realtime.service';

@Component({
  selector: 'app-client-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  templateUrl: './client-layout.component.html',
  styleUrl: './client-layout.component.scss',
})
export class ClientLayoutComponent implements OnDestroy {
  private readonly rt = inject(ClientRealtimeService);
  private readonly disconnectRt = this.rt.connect();
  private readonly auth = inject(ClientAuthService);
  private readonly router = inject(Router);

  readonly client = this.auth.client;
  readonly scrolled = signal(false);

  // Sub-navegación por secciones del dashboard (anclas, misma página).
  readonly sections = [
    { id: 'conversaciones', label: 'Conversaciones' },
    { id: 'bot', label: 'Bot' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'horario', label: 'Horario' },
    { id: 'listablanca', label: 'Lista blanca' },
    { id: 'sinbot', label: 'Números sin bot' },
  ];

  onDashboard(): boolean {
    return !this.router.url.startsWith('/panel/ajustes');
  }

  scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  @HostListener('window:scroll')
  onScroll() {
    this.scrolled.set(window.scrollY > 8);
  }

  ngOnDestroy() {
    this.disconnectRt();
  }

  logout() {
    this.auth.logout().subscribe({
      next: () => this.router.navigate(['/panel/login']),
      error: () => this.router.navigate(['/panel/login']),
    });
  }
}
