/// <reference lib="dom" />
declare global {
    interface Window {
        WPP: any;
    }
}
import { webkit, BrowserContext, Page } from 'playwright';
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

    constructor() {
        super();
        this.ensureSessionDir();
    }

    private ensureSessionDir() {
        if (!fs.existsSync(env.waSessionPath)) {
            fs.mkdirSync(env.waSessionPath, { recursive: true });
        }
    }

    async createInstance(instanceId: string): Promise<WAInstance> {
        if (this.instances.has(instanceId)) {
            throw new Error(`Instance ${instanceId} already exists`);
        }

        const sessionPath = path.join(env.waSessionPath, instanceId);

        logger.info({ instanceId, engine: 'WebKit' }, 'Launching Safari/WebKit instance...');

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

        const launchOptions: any = {
            headless: true, // Set to false to see the browser
            viewport: { width: 1280, height: 960 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
            bypassCSP: true, // Important for injecting scripts
        };

        // Configure Proxy if exists
        if (dbInstance?.proxyHost && dbInstance?.proxyPort) {
            const protocol = dbInstance.proxyProtocol || 'http';
            let host = dbInstance.proxyHost;

            // Handle IPv6: If it contains ':' and isn't already wrapped in [], add them.
            if (host.includes(':') && !host.startsWith('[')) {
                host = `[${host}]`;
            }

            launchOptions.proxy = {
                server: `${protocol}://${host}:${dbInstance.proxyPort}`,
            };

            if (dbInstance.proxyUsername && dbInstance.proxyPassword) {
                launchOptions.proxy.username = dbInstance.proxyUsername;
                launchOptions.proxy.password = dbInstance.proxyPassword;
            }

            logger.info({ instanceId, proxy: launchOptions.proxy.server }, 'Using Proxy configuration');
        }

        // Launch Persistent Context (Saves session data)
        const context = await webkit.launchPersistentContext(sessionPath, launchOptions);

        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        const instance: WAInstance = {
            context,
            page,
            id: instanceId,
            status: 'disconnected',
        };

        this.instances.set(instanceId, instance);

        // Handle Disconnect
        context.on('close', () => {
            this.updateInstanceStatus(instanceId, 'DISCONNECTED');
            instance.status = 'disconnected';
            this.emit('disconnected', { instanceId });
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

        return await instance.page.evaluate(({ chatId, content }) => {
            // @ts-ignore
            return window.WPP.chat.sendText(chatId, content);
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
