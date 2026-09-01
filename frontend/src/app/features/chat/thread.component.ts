import {
  AfterViewChecked, Component, ElementRef, EventEmitter, Input, Output, ViewChild, signal,
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
  @Output() sendFile = new EventEmitter<{ dataBase64: string; mimetype: string; fileName: string }>();
  @Output() resume = new EventEmitter<void>();

  draft = '';
  readonly fileError = signal<string | null>(null);

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

  mediaUrl(m: { id: string | null }): string {
    return `/api/sessions/chat/media?clientId=${this.conv?.clientId}&id=${encodeURIComponent(m.id || '')}`;
  }

  mediaKind(m: { msgType?: string | null }): 'image' | 'video' | 'audio' | 'file' {
    switch (m.msgType) {
      case 'imageMessage':
      case 'stickerMessage': return 'image';
      case 'videoMessage': return 'video';
      case 'audioMessage': return 'audio';
      default: return 'file';
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.fileError.set(null);
    if (file.size > 16 * 1024 * 1024) {
      this.fileError.set('Máximo 16MB por archivo');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      this.sendFile.emit({
        dataBase64: base64,
        mimetype: file.type || 'application/octet-stream',
        fileName: file.name,
      });
    };
    reader.readAsDataURL(file);
  }

  sourceLabel(source?: string): string {
    switch (source) {
      case 'webhook-response': return 'bot';
      case 'auto-reply': return 'aviso automático';
      case 'form-link': return 'formulario';
      case 'file-attachment': return 'adjunto';
      case 'chatbot': return 'manual';
      default: return source || '';
    }
  }
}
