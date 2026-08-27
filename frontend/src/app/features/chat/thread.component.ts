import {
  AfterViewChecked, Component, ElementRef, EventEmitter, Input, Output, ViewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Conversation } from '../../core/api/chat.service';
import { HandoffInfo } from '../../core/api/sessions.service';
import { ContactProfile } from '../../core/api/contacts.service';
import { AvatarComponent } from '../../shared/avatar.component';

/**
 * Hilo de conversación presentacional (burbujas + composer). Reutilizable:
 * lo usan /chat y la pestaña Conversaciones del detalle de cliente.
 */
@Component({
  selector: 'app-chat-thread',
  standalone: true,
  imports: [DatePipe, FormsModule, AvatarComponent],
  templateUrl: './thread.component.html',
  styleUrl: './thread.component.scss',
})
export class ThreadComponent implements AfterViewChecked {
  @Input() conv: Conversation | null = null;
  @Input() contactLabel = '';
  @Input() contactPhone = '';
  @Input() profile: ContactProfile | null | undefined;
  @Input() handoff: HandoffInfo | undefined;
  @Input() canSend = false;
  @Input() sendHint = '';
  @Input() sending = false;

  @Output() send = new EventEmitter<string>();
  @Output() resume = new EventEmitter<void>();

  draft = '';

  @ViewChild('scroller') private scroller?: ElementRef<HTMLDivElement>;
  private lastCount = -1;

  ngAfterViewChecked() {
    const count = this.conv?.messages.length ?? 0;
    if (count !== this.lastCount && this.scroller) {
      this.lastCount = count;
      const el = this.scroller.nativeElement;
      el.scrollTop = el.scrollHeight;
    }
  }

  submit() {
    const text = this.draft.trim();
    if (!text || !this.canSend || this.sending) return;
    this.send.emit(text);
    this.draft = '';
  }

  sourceLabel(source?: string): string {
    switch (source) {
      case 'webhook-response': return 'bot';
      case 'auto-reply': return 'aviso automático';
      case 'form-link': return 'formulario';
      case 'chatbot': return 'manual';
      default: return source || '';
    }
  }
}
