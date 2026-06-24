import { Component, inject } from '@angular/core';
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

  logout() {
    this.auth.logout().subscribe({
      next: () => this.router.navigate(['/panel/login']),
      error: () => this.router.navigate(['/panel/login']),
    });
  }
}
