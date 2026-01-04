/// <reference lib="dom" />
declare global {
    interface Window {
        WPP: any;
    }
}
import { webkit, Browser, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

export interface WAInstance {
    context: BrowserContext;
    page: Page;
    id: string;
    status: 'disconnected' | 'connecting' | 'connected' | 'qr';
    qrCode?: string;
    qrCodeBase64?: string;
    gcInterval?: NodeJS.Timeout;
}

export type WAEvent =
    | 'qr'
    | 'ready'
    | 'authenticated'
    | 'auth_failure'
    | 'disconnected'
    | 'message'
    | 'message_create'
    | 'message_ack'
    | 'message_revoke_everyone'
    | 'group_join'
    | 'group_leave'
    | 'group_update'
    | 'call';

export class WhatsAppManager extends EventEmitter {
    private instances: Map<string, WAInstance> = new Map();
    private static sharedBrowser: Browser | null = null; // Static to ensure singleton across restarts if manager is recreated

    constructor() {
        super();
        this.ensureSessionDir();
    }

    private ensureSessionDir() {
        if (!fs.existsSync(env.waSessionPath)) {
            fs.mkdirSync(env.waSessionPath, { recursive: true });
        }
    }

    private async getSharedBrowser() {
        if (!WhatsAppManager.sharedBrowser) {
            logger.info('Launching SHARED WebKit Browser (Singleton)...');
            WhatsAppManager.sharedBrowser = await webkit.launch({
                headless: true
            });

            // Handle browser crash/close
            WhatsAppManager.sharedBrowser.on('disconnected', () => {
                logger.error('SHARED BROWSER DISCONNECTED! Resetting...');
                WhatsAppManager.sharedBrowser = null;
            });
        } else {
            logger.info('Reusing existing SHARED WebKit Browser ♻️');
        }
        return WhatsAppManager.sharedBrowser;
    }

    async createInstance(instanceId: string): Promise<WAInstance> {
        if (this.instances.has(instanceId)) {
            throw new Error(`Instance ${instanceId} already exists`);
        }

        const sessionDir = path.join(env.waSessionPath, instanceId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        const stateFile = path.join(sessionDir, 'state.json');

        logger.info({ instanceId, engine: 'WebKit', mode: 'Context' }, 'Creating Browser Context...');

        // Fetch proxy settings from DB
        const dbInstance = await prisma.instance.findUnique({
            where: { id: instanceId },
            select: {
                proxyHost: true,
                proxyPort: true,
                proxyProtocol: true,
                proxyUsername: true,
                proxyPassword: true,
            }
        });

        // Load saved state if exists
        let storageState: string | undefined = undefined;
        if (fs.existsSync(stateFile)) {
            try {
                // Verify if valid JSON
                JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                storageState = stateFile;
                logger.info({ instanceId }, 'Restoring session from state.json');
            } catch (e) {
                logger.warn({ instanceId }, 'Invalid state file, starting fresh');
            }
        }

        // MEMORY OPTIMIZATIONS (balanced for functionality)
        const contextOptions: any = {
            storageState, // Load session
            viewport: { width: 1, height: 1 }, // Minimal viewport to save Framebuffer RAM
            deviceScaleFactor: 1, // Standard DPI
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
            bypassCSP: true,
            javaScriptEnabled: true,
            locale: 'pt-BR',
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block', // Block Service Workers (High Memory Usage)
            colorScheme: 'dark',
            reducedMotion: 'reduce',
        };

        // Configure Proxy
        if (dbInstance?.proxyHost && dbInstance?.proxyPort) {
            const protocol = dbInstance.proxyProtocol || 'http';
            let host = dbInstance.proxyHost;
            if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;

            contextOptions.proxy = {
                server: `${protocol}://${host}:${dbInstance.proxyPort}`,
            };
            if (dbInstance.proxyUsername && dbInstance.proxyPassword) {
                contextOptions.proxy.username = dbInstance.proxyUsername;
                contextOptions.proxy.password = dbInstance.proxyPassword;
            }
        }

        const browser = await this.getSharedBrowser();
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        logger.info({
            instanceId,
            activeContexts: browser.contexts().length,
            message: 'Browser Context Created'
        }, 'Singleton Stats 📊');

        // Auto-save state on changes
        const saveState = async () => {
            try {
                await context.storageState({ path: stateFile });
            } catch (e) { /* ignore errors during close */ }
        };

        // Save state periodically and on important events
        page.on('load', saveState);
        page.on('close', saveState);
        setInterval(saveState, 60000); // Autosave every minute


        // AGGRESSIVE RESOURCE BLOCKING - Block everything non-essential
        await page.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            const url = route.request().url();

            // Always allow WhatsApp's critical JS and document
            if (resourceType === 'document' || resourceType === 'script') {
                if (url.includes('web.whatsapp.com') || url.includes('static.whatsapp')) {
                    return route.continue();
                }
            }

            // Allow XHR/Fetch for messaging to work
            if (resourceType === 'xhr' || resourceType === 'fetch') {
                if (url.includes('whatsapp') || url.includes('wa.me')) {
                    return route.continue();
                }
            }

            // Allow websocket connections
            if (resourceType === 'websocket') {
                return route.continue();
            }

            // Block ALL images - including profile pics
            if (resourceType === 'image') return route.abort();

            // Block ALL fonts
            if (resourceType === 'font') return route.abort();

            // Block ALL media (audio, video)
            if (resourceType === 'media') return route.abort();

            // Block other non-essential
            if (['manifest', 'other', 'texttrack', 'eventsource', 'websocket'].includes(resourceType)) {
                // Keep websocket for WhatsApp? WhatsApp uses websocket.
                if (resourceType === 'websocket' && (url.includes('whatsapp') || url.includes('wa.me'))) {
                    return route.continue();
                }
                if (resourceType !== 'websocket') return route.abort();
            }

            // Block stylesheets except WhatsApp's main CSS
            if (resourceType === 'stylesheet') {
                if (!url.includes('web.whatsapp.com')) {
                    return route.abort();
                }
            }

            // Block tracking, analytics, and CDNs we don't need
            const blockedDomains = [
                'google-analytics', 'facebook.com/tr', 'fbcdn.net',
                'doubleclick', 'googletagmanager', 'analytics',
                'crashlytics', 'sentry.io', 'hotjar', 'clarity.ms'
            ];

            if (blockedDomains.some(domain => url.includes(domain))) {
                return route.abort();
            }

            return route.continue();
        });

        // Periodic Memory Cleanup (Force GC inside page if available)
        setInterval(async () => {
            if (page.isClosed()) return;
            try {
                await page.evaluate(() => {
                    if ((window as any).gc) (window as any).gc();
                    if ('caches' in window) window.caches.keys().then(names => {
                        for (const name of names) window.caches.delete(name);
                    });
                });
            } catch (e) { /* ignore */ }
        }, 300000); // Every 5 minutes

        // GC will be triggered when instance is cleaned up

        const instance: WAInstance = {
            context,
            page,
            id: instanceId,
            status: 'disconnected',
        };

        this.instances.set(instanceId, instance);

        // Handle Disconnect and cleanup
        context.on('close', () => {
            this.updateInstanceStatus(instanceId, 'DISCONNECTED');
            instance.status = 'disconnected';
            this.instances.delete(instanceId);
            this.emit('disconnected', { instanceId });

            // Trigger garbage collection after cleanup
            if (global.gc) {
                try { global.gc(); } catch (e) { /* ignore */ }
            }
        });

        return instance;
    }

    async connect(instanceId: string): Promise<WAInstance> {
        let instance = this.instances.get(instanceId);
        if (!instance) instance = await this.createInstance(instanceId);

        if (instance.status === 'connected' || instance.status === 'connecting') return instance;

        instance.status = 'connecting';
        this.emit('status_change', { instanceId, status: 'connecting' });

        // Run async without awaiting to not block server
        this.initializePage(instance).catch(err => {
            logger.error({ instanceId, err }, 'Failed to initialize page');
            instance!.status = 'disconnected';
        });

        return instance;
    }

    private async initializePage(instance: WAInstance) {
        const { page, id } = instance;

        try {
            logger.info({ id }, 'Navigating to WhatsApp Web...');
            await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

            // Wait for initial load
            await page.waitForTimeout(3000);

            // Inject WPPConnect/WA-JS
            await this.injectWPPScript(page, id);

            // Wait for WhatsApp to load
            await page.waitForTimeout(2000);

            // Check for potential QR Code or Ready state loop
            this.monitorState(instance);

        } catch (error) {
            logger.error({ id, error }, 'Error during page initialization');
        }
    }

    private async injectWPPScript(page: any, id: string) {
        try {
            // Use official WPPConnect wa-js package
            await page.addScriptTag({
                url: 'https://cdn.jsdelivr.net/npm/@wppconnect/wa-js@3/dist/wppconnect-wa.js'
            });
            logger.info({ id }, 'WPPConnect script injected');

            // Wait for WPP to initialize
            await page.waitForTimeout(2000);

            // Check if WPP is available
            const wppAvailable = await page.evaluate(() => typeof window.WPP !== 'undefined');
            if (wppAvailable) {
                logger.info({ id }, 'WPP is available');
            } else {
                logger.warn({ id }, 'WPP object not available after injection');
            }
        } catch (scriptError) {
            logger.warn({ id, scriptError }, 'Failed to inject WPPConnect script');
        }
    }

    private async monitorState(instance: WAInstance) {
        const { page, id } = instance;

        let attempts = 0;
        const checkInterval = setInterval(async () => {
            if (attempts > 120) { // 2 minutes timeout
                clearInterval(checkInterval);
                return;
            }
            attempts++;

            try {
                // Check if connected (Main page element present)
                const isConnected = await page.$('#pane-side');
                if (isConnected) {
                    if (instance.status !== 'connected') {
                        logger.info({ id }, 'WhatsApp Connected!');
                        instance.status = 'connected';
                        instance.qrCode = undefined;
                        instance.qrCodeBase64 = undefined;

                        // Re-inject WPP script if not available (for messaging)
                        const wppAvailable = await page.evaluate(() => typeof window.WPP !== 'undefined');
                        if (!wppAvailable) {
                            logger.info({ id }, 'Re-injecting WPP script after connection...');
                            await this.injectWPPScript(page, id);
                        }

                        // Extract profile info
                        await this.extractProfileInfo(instance);

                        this.updateInstanceStatus(id, 'CONNECTED');
                        this.emit('ready', { instanceId: id });
                        this.emit('authenticated', { instanceId: id });
                        clearInterval(checkInterval);
                    }
                    return;
                }

                // Check for QR Code
                const qrCanvas = await page.$('canvas');
                if (qrCanvas) {
                    // Generate Base64 for display
                    const qrBase64 = await page.evaluate(() => {
                        const canvas = document.querySelector('canvas');
                        return canvas ? canvas.toDataURL() : null;
                    });

                    // Use a hash of the base64 as the QR identifier to detect changes
                    if (qrBase64 && instance.qrCodeBase64 !== qrBase64) {
                        instance.status = 'qr';
                        instance.qrCode = qrBase64; // Use base64 as the identifier too
                        instance.qrCodeBase64 = qrBase64;
                        logger.info({ id }, 'QR Code generated');
                        this.emit('qr', { instanceId: id, qr: qrBase64, qrBase64 });
                    }
                }

            } catch (err) {
                // ignore transient errors
            }
        }, 1000);
    }

    getStatus(instanceId: string) {
        const instance = this.instances.get(instanceId);
        if (!instance) return 'not_found';
        return instance.status;
    }

    getQRCode(instanceId: string) {
        const instance = this.instances.get(instanceId);
        return { qr: instance?.qrCode, qrBase64: instance?.qrCodeBase64 };
    }

    // Helper to update DB status
    private async updateInstanceStatus(id: string, status: string) {
        await prisma.instance.update({
            where: { id },
            data: { status: status as any }
        });
    }

    // Extract and save profile info (number, name) after connection
    private async extractProfileInfo(instance: WAInstance) {
        const { page, id } = instance;

        try {
            // Wait a bit for WPP to fully initialize
            await page.waitForTimeout(3000);

            // Try to get profile info using WPP
            const profileInfo = await page.evaluate(async () => {
                if (typeof window.WPP === 'undefined' || !window.WPP.conn) {
                    return null;
                }

                try {
                    const me = await window.WPP.conn.getMe();
                    return {
                        waNumber: me?.wid?.user || me?.user,
                        waName: me?.pushname || me?.name
                    };
                } catch (e) {
                    return null;
                }
            });

            if (profileInfo && (profileInfo.waNumber || profileInfo.waName)) {
                logger.info({ id, profileInfo }, 'Profile info extracted');

                // Save to database
                await prisma.instance.update({
                    where: { id },
                    data: {
                        waNumber: profileInfo.waNumber || null,
                        waName: profileInfo.waName || null
                    }
                });
            } else {
                logger.warn({ id }, 'Could not extract profile info from WPP');
            }
        } catch (error) {
            logger.error({ id, error }, 'Error extracting profile info');
        }
    }

    // Stub for reconnectAll (can be implemented similarly to before)
    async reconnectAll() {
        const instances = await prisma.instance.findMany({ where: { status: 'CONNECTED' } });
        for (const inst of instances) {
            this.connect(inst.id); // fire and forget
        }
    }

    // ==========================================
    // Messaging Methods (Using WPPConnect injection)
    // ==========================================


    async sendMessage(instanceId: string, to: string, content: string) {
        const instance = this.instances.get(instanceId);
        if (!instance || instance.status !== 'connected') throw new Error('Instance not connected');

        // Format number (simple version)
        const chatId = to.includes('@') ? to : `${to}@c.us`;

        // Wait for WPP to be ready and use correct API function name
        return await instance.page.evaluate(async ({ chatId, content }) => {
            // Wait for WPP to be fully loaded
            if (typeof window.WPP === 'undefined') {
                throw new Error('WPP not loaded');
            }

            // Use sendTextMessage (not sendText) - correct API for wa-js@3
            // @ts-ignore
            return await window.WPP.chat.sendTextMessage(chatId, content);
        }, { chatId, content });
    }

    // ==========================================
    // Stubs for Compatibility (To be implemented)
    // ==========================================

    async getContacts(_instanceId: string) { return []; }
    async getContactById(_instanceId: string, _contactId: string) { return null; }
    async isRegisteredUser(_instanceId: string, _number: string) { return true; }
    async blockContact(_instanceId: string, _contactId: string) { }
    async unblockContact(_instanceId: string, _contactId: string) { }
    async getBlockedContacts(_instanceId: string) { return []; }
    async getProfilePicUrl(_instanceId: string, _contactId: string) { return ''; }

    async getChats(_instanceId: string) { return []; }
    async getChatById(_instanceId: string, _chatId: string) { return null; }
    async getMessages(_instanceId: string, _chatId: string, _limit = 50) { return []; }
    async clearChat(_instanceId: string, _chatId: string) { }
    async deleteChat(_instanceId: string, _chatId: string) { }
    async archiveChat(_instanceId: string, _chatId: string) { }
    async unarchiveChat(_instanceId: string, _chatId: string) { }
    async pinChat(_instanceId: string, _chatId: string) { }
    async unpinChat(_instanceId: string, _chatId: string) { }
    async muteChat(_instanceId: string, _chatId: string, _duration?: any) { }
    async unmuteChat(_instanceId: string, _chatId: string) { }
    async markChatUnread(_instanceId: string, _chatId: string) { }
    async resolveChatId(_instance: any, number: string) { return number.includes('@') ? number : number + '@c.us'; }

    async createGroup(_instanceId: string, _name: string, _participants: string[]) { return {}; }
    async getGroupInfo(_instanceId: string, _groupId: string) { return {}; }
    async addParticipants(_instanceId: string, _groupId: string, _participants: string[]) { }
    async removeParticipants(_instanceId: string, _groupId: string, _participants: string[]) { }
    async promoteParticipants(_instanceId: string, _groupId: string, _participants: string[]) { }
    async demoteParticipants(_instanceId: string, _groupId: string, _participants: string[]) { }
    async setGroupSubject(_instanceId: string, _groupId: string, _subject: string) { }
    async setGroupDescription(_instanceId: string, _groupId: string, _description: string) { }
    async leaveGroup(_instanceId: string, _groupId: string) { }
    async getInviteCode(_instanceId: string, _groupId: string) { return ''; }
    async revokeInviteCode(_instanceId: string, _groupId: string) { return ''; }
    async joinGroupByInviteCode(_instanceId: string, _inviteCode: string) { return ''; }

    async sendMedia(_instanceId: string, _to: string, _mediaUrl: string, _options?: any) { }
    async sendMediaBase64(_instanceId: string, _to: string, _base64: string, _mimetype: string, _options?: any) { }
    async sendLocation(_instanceId: string, _to: string, _latitude: number, _longitude: number, _description?: string) { }
    async sendContact(_instanceId: string, _to: string, _contactId: string) { }
    async sendPoll(_instanceId: string, _to: string, _title: string, _options: string[], _pollOptions?: any) { }
    async sendPresence(_instanceId: string, _to: string, _presence: any) { }
    async editMessage(_instanceId: string, _messageId: string, _newText: string) { }
    async reactToMessage(_instanceId: string, _messageId: string, _reaction: string) { }
    async deleteMessage(_instanceId: string, _messageId: string, _forEveryone: boolean = true) { }
    async downloadMedia(_instanceId: string, _messageId: string, _options?: any) { return null; }

    async sendText(instanceId: string, to: string, content: string) {
        return this.sendMessage(instanceId, to, content);
    }

    // Aliases for compatibility
    async getChatMessages(instanceId: string, chatId: string, limit = 50) { return this.getMessages(instanceId, chatId, limit); }
    async markChatAsRead(instanceId: string, chatId: string) { return this.markChatUnread(instanceId, chatId); }
    async markChatAsUnread(instanceId: string, chatId: string) { return this.markChatUnread(instanceId, chatId); }

    // Profile
    async setProfileName(_instanceId: string, _name: string) { }
    async setMyStatus(_instanceId: string, _status: string) { }
    async setStatus(instanceId: string, status: string) { return this.setMyStatus(instanceId, status); }
    async setProfilePicture(_instanceId: string, _url: string) { }

    // Labels
    async getLabels(_instanceId: string) { return []; }
    async addLabelToChat(_instanceId: string, _chatId: string, _labelId: string) { }
    async removeLabelFromChat(_instanceId: string, _chatId: string, _labelId: string) { }

    async updateInstanceSettings(_id: string, _settings: any) {
        // ... logic to update settings
    }
    async updateSettings(instanceId: string, settings: any) { return this.updateInstanceSettings(instanceId, settings); }
    async getSettings(instanceId: string) { return this.instanceSettings.get(instanceId) || {}; }

    formatNumber(number: string): string {
        return number.replace(/\D/g, '');
    }

    async disconnect(instanceId: string) { await this.logout(instanceId); }

    private instanceSettings: Map<string, any> = new Map();
    public alwaysOnlineIntervals: Map<string, NodeJS.Timeout> = new Map();

    async logout(instanceId: string) {
        const instance = this.instances.get(instanceId);
        if (instance) {
            await instance.context.close().catch(() => { });
            this.instances.delete(instanceId);
        }
    }

    async deleteInstance(instanceId: string) {
        await this.logout(instanceId);
        // Additional cleanup if needed
    }

    getInstance(instanceId: string) { return this.instances.get(instanceId); }
    getClient(instanceId: string) { return this.instances.get(instanceId)?.page; }
    getAllInstances() { return Array.from(this.instances.keys()); }
}

export const waManager = new WhatsAppManager();
