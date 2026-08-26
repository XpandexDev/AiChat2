import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ClientAuthService } from '../../core/auth/client-auth.service';
import { errorToMessage } from '../../core/api/error';
import { ArrowButtonComponent } from '../../shared/arrow-button.component';
import { SpotlightDirective } from '../../shared/spotlight.directive';

@Component({
  selector: 'app-client-login',
  standalone: true,
  imports: [FormsModule, ArrowButtonComponent, SpotlightDirective],
  templateUrl: './client-login.component.html',
  styleUrl: './client-login.component.scss',
})
export class ClientLoginComponent {
  private readonly auth = inject(ClientAuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  email = '';
  password = '';
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  submit() {
    if (!this.email.trim() || !this.password) {
      this.error.set('Email y contraseña son obligatorios');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth.login(this.email.trim().toLowerCase(), this.password).subscribe({
      next: () => {
        this.loading.set(false);
        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') || '/panel';
        this.router.navigateByUrl(returnUrl);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(errorToMessage(err, 'No se pudo iniciar sesión'));
      },
    });
  }
}
