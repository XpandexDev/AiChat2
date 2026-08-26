import { Component, HostListener, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { ClientAuthService } from '../../core/auth/client-auth.service';

@Component({
  selector: 'app-client-layout',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './client-layout.component.html',
  styleUrl: './client-layout.component.scss',
})
export class ClientLayoutComponent {
  private readonly auth = inject(ClientAuthService);
  private readonly router = inject(Router);

  readonly client = this.auth.client;
  readonly scrolled = signal(false);

  @HostListener('window:scroll')
  onScroll() {
    this.scrolled.set(window.scrollY > 8);
  }

  logout() {
    this.auth.logout().subscribe({
      next: () => this.router.navigate(['/panel/login']),
      error: () => this.router.navigate(['/panel/login']),
    });
  }
}
