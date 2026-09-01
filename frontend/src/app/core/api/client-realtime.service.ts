import { Injectable, OnDestroy, signal } from '@angular/core';
import { Socket, io } from 'socket.io-client';

/**
 * Tiempo real del panel de cliente. El socket viaja con la cookie
 * `client_session`; el servidor la valida y mete la conexión SOLO en la sala
 * de ese cliente (`client:<id>`) — no puede ver datos de otros clientes.
 * El dashboard reacciona al contador `tick` recargando lo que toque.
 */
@Injectable({ providedIn: 'root' })
export class ClientRealtimeService implements OnDestroy {
  readonly connected = signal(false);
  readonly tick = signal(0);
  readonly lastEvent = signal<string | null>(null);

  private socket: Socket | null = null;
  private refCount = 0;

  connect(): () => void {
    this.refCount += 1;
    if (this.refCount === 1) this.open();
    return () => this.disconnect();
  }

  private disconnect() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0 && this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected.set(false);
    }
  }

  private open() {
    this.socket = io({ path: '/socket.io', withCredentials: true });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    const relevant = ['handoff:started', 'handoff:resumed', 'session:update', 'message:incoming'];
    for (const ev of relevant) {
      this.socket.on(ev, () => {
        this.lastEvent.set(ev);
        this.tick.set(this.tick() + 1);
      });
    }
  }

  ngOnDestroy() {
    if (this.socket) this.socket.disconnect();
  }
}
