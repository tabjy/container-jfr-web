import { Injectable, OnDestroy } from '@angular/core';
import { Subject, BehaviorSubject, Observable, ReplaySubject, combineLatest } from 'rxjs';
import { filter, first, map } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { NotificationService, NotificationType } from 'patternfly-ng/notification';
import { ApiService } from './api.service';

@Injectable()
export class CommandChannelService implements OnDestroy {

  private ws: WebSocket;
  private readonly messages = new Subject<ResponseMessage<any>>();
  private readonly ready = new BehaviorSubject<boolean>(false);
  private readonly archiveEnabled = new ReplaySubject<boolean>(1);
  private readonly clientUrlSubject = new ReplaySubject<string>(1);
  private readonly grafanaDatasourceUrlSubject = new ReplaySubject<string>(1);
  private pingTimer: number;

  constructor(
    private http: HttpClient,
    private api: ApiService,
    private notifications: NotificationService,
  ) {
    this.http.get('/clienturl')
      .subscribe(
        (url: ({ clientUrl: string })) => this.clientUrlSubject.next(url.clientUrl),
        (err: any) => this.notifications.message(
          NotificationType.WARNING, 'Client URL Request Error', JSON.stringify(err), false, null, null
        )
      );

    this.http.get('/grafana_datasource_url')
      .subscribe(
        (url: ({ grafanaDatasourceUrl: string})) => this.grafanaDatasourceUrlSubject.next(url.grafanaDatasourceUrl),
        (err: any) => this.notifications.message(
          NotificationType.WARNING, 'Grafana URL Request Error', JSON.stringify(err), false, null, null
        )
      );

    this.clientUrl().pipe(
      first()
    ).subscribe(url => this.connect(url));

    this.messages.pipe(
      filter(msg => msg.status !== 0),
      filter(msg => msg.commandName !== 'disconnect')
    ).subscribe(msg => this.notifications.message(
      NotificationType.WARNING, msg.commandName, msg.payload, false, null, null
    ));

    this.messages.pipe(
      filter(msg => msg.commandName === 'list-saved'),
      first(),
      map(msg => msg.status === 0)
    ).subscribe(listSavedEnabled => this.archiveEnabled.next(listSavedEnabled));

    this.notifications.setDelay(15000);
  }

  clientUrl(): Observable<string> {
    return combineLatest(
      this.clientUrlSubject.asObservable(),
      this.api.getToken()
    ).pipe(
      map(v => `${v[0]}?token=${v[1]}`)
    );
  }

  grafanaDatasourceUrl(): Observable<string> {
    return this.grafanaDatasourceUrlSubject.asObservable();
  }

  connect(clientUrl: string): void {
    this.ws = new WebSocket(clientUrl);

    this.ws.addEventListener('open', () => this.ready.next(true));

    this.ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        this.messages.next(JSON.parse(ev.data));
      }
    });

    this.ws.addEventListener('close', () => {
      this.ready.next(false);
      window.clearInterval(this.pingTimer);
      this.notifications.message(
        NotificationType.INFO, 'WebSocket connection lost', null, false, null, null
      );
    });

    this.ws.addEventListener('open', () => {
      this.pingTimer = window.setInterval(() => {
        this.sendMessage('ping');
      }, 10 * 1000);
    });

    this.ws.addEventListener('open', () => {
      this.sendMessage('list-saved');
    });

    this.ws.addEventListener('error', (evt: Event) => this.notifications.message(
      NotificationType.WARNING, 'WebSocket Error', JSON.stringify(evt), false, null, null
    ));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      delete this.ws;
    }
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  isReady(): Observable<boolean> {
    return this.ready.asObservable();
  }

  isArchiveEnabled(): Observable<boolean> {
    return this.archiveEnabled.asObservable();
  }

  addCloseHandler(handler: () => void): void {
    this.ws.addEventListener('close', handler);
  }

  sendMessage(command: string, args: string[] = []): void {
    if (this.ws) {
      this.ws.send(JSON.stringify({ command, args } as CommandMessage));
    }
  }

  onResponse(command: string): Observable<ResponseMessage<any>> {
    return this.messages
      .asObservable()
      .pipe(
        filter(m => m.commandName === command)
      );
  }
}

export interface CommandMessage {
  command: string;
  args?: string[];
}

export interface ResponseMessage<T> {
  status: number;
  commandName: string;
  payload: T;
}

export interface SuccessMessage extends ResponseMessage<void> { }

export function isSuccessMessage(m: ResponseMessage<any>): m is SuccessMessage {
  return m.status === 0;
}

export interface StringMessage extends ResponseMessage<string> { }

export function isStringMessage(m: ResponseMessage<any>): m is StringMessage {
  return m.status === 0 && typeof m.payload === 'string';
}

export interface ListMessage extends ResponseMessage<any[]> { }

export function isListMessage(m: ResponseMessage<any>): m is ListMessage {
  return m.status === 0 && Array.isArray(m.payload);
}

export interface FailureMessage extends ResponseMessage<string> { }

export function isFailureMessage(m: ResponseMessage<any>): m is FailureMessage {
  return m.status < 0 && typeof m.payload === 'string';
}

export interface ExceptionMessage extends ResponseMessage<{ commandName: string, exception: string }> { }

export function isExceptionMessage(m: ResponseMessage<any>): m is ExceptionMessage {
  return m.status < 0
    && m.payload != null
    && m.payload.commandName != null && typeof m.payload.commandName === 'string'
    && m.payload.exception != null && typeof m.payload.exception === 'string';
}
