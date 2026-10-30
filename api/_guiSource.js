import { deliveryAttestation } from './_loaderToken.js';
import { buildPayloadRuntime, compactGeneratedLoader, loaderBootQuery, luaString, packGeneratedLoader, robloxOnlyGuard } from './_loaderSource.js';
import { buildRemovedVaultGui } from './_removedVaultGui.js';

export function sanitizeGuiAppearance(raw = {}) {
    if (!raw || typeof raw !== 'object') raw = {};
    const text = (value, fallback, maxLength) => typeof value === 'string'
        ? value.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim().slice(0, maxLength) || fallback
        : fallback;
    const color = (value, fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
        ? value
        : fallback;
    const backgroundAnimation = ['none', 'aurora', 'drift', 'orbit', 'nebula', 'waves', 'pulse', 'scanline', 'starlight', 'shimmer', 'particles', 'ripple', 'comet', 'grid', 'corners'].includes(raw.backgroundAnimation)
        ? raw.backgroundAnimation
        : 'aurora';
    const backgroundColor = color(raw.backgroundColor, '#0b0d12');
    const requestedTextColor = color(raw.textColor, '#f8fafc');
    const linearChannel = channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = hex => {
        const values = hex.slice(1).match(/.{2}/g).map(part => parseInt(part, 16));
        return 0.2126 * linearChannel(values[0]) + 0.7152 * linearChannel(values[1]) + 0.0722 * linearChannel(values[2]);
    };
    const contrast = (first, second) => {
        const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const textColor = contrast(requestedTextColor, backgroundColor) >= 4.5
        ? requestedTextColor
        : (contrast('#f8fafc', backgroundColor) >= contrast('#111827', backgroundColor) ? '#f8fafc' : '#111827');
    return {
        title: text(raw.title, 'VoidedX Key System', 40),
        subtitle: text(raw.subtitle, 'Enter your key to continue', 64),
        buttonLabel: text(raw.buttonLabel, 'Submit', 20),
        accentColor: color(raw.accentColor, '#06b6d4'),
        secondaryColor: color(raw.secondaryColor, '#6366f1'),
        backgroundColor,
        textColor,
        backgroundAnimation
    };
}

export function buildGuiLoader(id, origin, rawAppearance = {}, rawVaultName = '', loaderToken, options = {}) {
    return packGeneratedLoader(buildGuiSource(id, origin, rawAppearance, rawVaultName, options, loaderToken), { id, origin, token: loaderToken });
}

export function buildGuiSource(id, origin, rawAppearance = {}, rawVaultName = '', options = {}, loaderToken = '') {
    // The in-game card only reaches /api/verify when it was served inside a real
    // bootstrap, so the attestation is added when a loader token exists; the
    // website preview builds the same card without one.
    const verifyBase = `${origin}/api/verify?id=${encodeURIComponent(id)}${loaderBootQuery(loaderToken, id)}`;
    const keyPageUrl = `${origin}/key.html?id=${id}`;
    const appearance = sanitizeGuiAppearance(rawAppearance);
    const vaultName = typeof rawVaultName === 'string'
        ? rawVaultName.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim().slice(0, 64) || `Vault ${id}`
        : `Vault ${id}`;
    const savedKeyFile = `VoidedX_Key_${String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}.txt`;
    const toRgb = hex => hex.match(/[a-f\d]{2}/gi).map(part => parseInt(part, 16));
    const [bgR, bgG, bgB] = toRgb(appearance.backgroundColor);
    const [accentR, accentG, accentB] = toRgb(appearance.accentColor);
    const [glowR, glowG, glowB] = toRgb(appearance.secondaryColor);
    const [textR, textG, textB] = toRgb(appearance.textColor);
    const colorLuminance = hex => {
        const channels = toRgb(hex).map(value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const buttonTextColor = (colorLuminance(appearance.accentColor) + colorLuminance(appearance.secondaryColor)) / 2 >= 0.18
        ? [17, 24, 39]
        : [248, 250, 252];
    const backgroundAnimation = appearance.backgroundAnimation;

    return compactGeneratedLoader(`
${robloxOnlyGuard()}
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local TweenService = game:GetService("TweenService")
local TextService = game:GetService("TextService")
local UserInputService = game:GetService("UserInputService")
local player = Players.LocalPlayer
local savedKeyPath = ${luaString(savedKeyFile)}
${buildPayloadRuntime(origin, options, id)}

local function readSavedKey()
    if type(readfile) ~= "function" then return nil end
    local ok, value = pcall(function()
        if type(isfile) == "function" and not isfile(savedKeyPath) then return nil end
        return readfile(savedKeyPath)
    end)
    if ok and type(value) == "string" and value ~= "" then return value end
    return nil
end

local function saveKeyLocally(key)
    if type(writefile) ~= "function" then return false end
    return pcall(function() writefile(savedKeyPath, key) end)
end

local function clearSavedKey()
    if type(delfile) == "function" then
        pcall(function() delfile(savedKeyPath) end)
    elseif type(writefile) == "function" then
        pcall(function() writefile(savedKeyPath, "") end)
    end
end

local function getGuiParent()
    local ok, hui = pcall(function() return gethui() end)
    if ok and hui then return hui end
    local ok2, cg = pcall(function() return game:GetService("CoreGui") end)
    if ok2 and cg then return cg end
    return player:WaitForChild("PlayerGui")
end

local guiParent = getGuiParent()
local oldStatusGui = guiParent:FindFirstChild("VoidedXKeyStatus")
if oldStatusGui then oldStatusGui:Destroy() end
local oldKeyGui = guiParent:FindFirstChild("VoidedXKeySystem")
if oldKeyGui then oldKeyGui:Destroy() end

local COL_BG = Color3.fromRGB(${bgR}, ${bgG}, ${bgB})
local COL_DEEP = COL_BG:Lerp(Color3.fromRGB(0, 0, 0), 0.42)
local COL_INPUT = COL_BG:Lerp(Color3.fromRGB(0, 0, 0), 0.24)
local COL_PANEL = COL_BG:Lerp(Color3.fromRGB(255, 255, 255), 0.05)
local COL_CYAN = Color3.fromRGB(${accentR}, ${accentG}, ${accentB})
local COL_ACCENT = Color3.fromRGB(${glowR}, ${glowG}, ${glowB})
local COL_TEXT = Color3.fromRGB(${textR}, ${textG}, ${textB})
local COL_LINE = COL_TEXT:Lerp(COL_BG, 0.8)
local COL_MUTED = COL_TEXT:Lerp(COL_BG, 0.38)
local COL_TINT = COL_CYAN:Lerp(COL_BG, 0.86)
local COL_SUCCESS = Color3.fromRGB(52, 211, 153)
local COL_DANGER = Color3.fromRGB(248, 113, 113)
local COL_INK = Color3.fromRGB(${buttonTextColor[0]}, ${buttonTextColor[1]}, ${buttonTextColor[2]})
local BACKGROUND_ANIMATION = ${luaString(backgroundAnimation)}

local EASE_OUT = Enum.EasingStyle.Quint
local EASE_BACK = Enum.EasingStyle.Back

local screenGui = Instance.new("ScreenGui")
screenGui.Name = "VoidedXKeySystem"
screenGui.ResetOnSpawn = false
screenGui.IgnoreGuiInset = true
screenGui.DisplayOrder = 999
screenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
screenGui.Parent = guiParent

local overlay = Instance.new("Frame")
overlay.Size = UDim2.fromScale(1, 1)
overlay.BackgroundColor3 = COL_DEEP
overlay.BackgroundTransparency = 1
overlay.BorderSizePixel = 0
overlay.ZIndex = 1
overlay.Parent = screenGui
local overlayGradient = Instance.new("UIGradient")
overlayGradient.Rotation = 118
overlayGradient.Color = ColorSequence.new(COL_DEEP, COL_BG:Lerp(COL_ACCENT, 0.08))
overlayGradient.Transparency = NumberSequence.new({
    NumberSequenceKeypoint.new(0, 0.04),
    NumberSequenceKeypoint.new(0.55, 0.3),
    NumberSequenceKeypoint.new(1, 0.06)
})
overlayGradient.Parent = overlay
TweenService:Create(overlay, TweenInfo.new(0.4, EASE_OUT), { BackgroundTransparency = 0 }):Play()

local camera = workspace.CurrentCamera
local touchDevice = false
pcall(function()
    touchDevice = UserInputService.TouchEnabled == true
end)
local CARD_BASE_HEIGHT = 346
local cardWidth = 430
local cardScale = 1
local phoneLayout = false
local statusHeight = 0

local card = Instance.new("Frame")
card.AnchorPoint = Vector2.new(0.5, 0.5)
card.Position = UDim2.new(0.5, 0, 0.5, 22)
card.Size = UDim2.fromOffset(cardWidth, CARD_BASE_HEIGHT)
card.BackgroundColor3 = COL_BG
card.BackgroundTransparency = 0
card.BorderSizePixel = 0
card.ClipsDescendants = false
card.ZIndex = 2
card.Parent = screenGui

local cardConstraint = Instance.new("UISizeConstraint")
cardConstraint.MaxSize = Vector2.new(430, 10000)
cardConstraint.Parent = card

local cardCorner = Instance.new("UICorner")
cardCorner.CornerRadius = UDim.new(0, 18)
cardCorner.Parent = card

local cardGradient = Instance.new("UIGradient")
cardGradient.Rotation = 112
cardGradient.Color = ColorSequence.new(COL_DEEP, COL_BG, COL_DEEP:Lerp(COL_ACCENT, 0.07))
cardGradient.Parent = card

local cardStroke = Instance.new("UIStroke")
cardStroke.Color = COL_CYAN
cardStroke.Thickness = 1
cardStroke.Transparency = 1
cardStroke.Parent = card

local strokeGradient = Instance.new("UIGradient")
strokeGradient.Rotation = 35
strokeGradient.Color = ColorSequence.new(COL_CYAN, COL_LINE, COL_ACCENT)
strokeGradient.Transparency = NumberSequence.new({
    NumberSequenceKeypoint.new(0, 0.15),
    NumberSequenceKeypoint.new(0.5, 0.75),
    NumberSequenceKeypoint.new(1, 0.15)
})
strokeGradient.Parent = cardStroke

local ambientGlows = {}
local animationLayer
if BACKGROUND_ANIMATION ~= "none" then
    animationLayer = Instance.new("Frame")
    animationLayer.Name = "VoidedXAnimatedBackground"
    animationLayer.Size = UDim2.fromScale(1, 1)
    animationLayer.BackgroundTransparency = 1
    animationLayer.BorderSizePixel = 0
    animationLayer.ClipsDescendants = true
    animationLayer.ZIndex = 2
    animationLayer.Parent = card
    local animationCorner = Instance.new("UICorner")
    animationCorner.CornerRadius = UDim.new(0, 18)
    animationCorner.Parent = animationLayer

    local function makeGlow(name, color, position, size, transparency)
        local glow = Instance.new("Frame")
        glow.Name = name
        glow.Position = position
        glow.Size = size
        glow.BackgroundColor3 = color
        glow.BackgroundTransparency = transparency or 0.72
        glow.BorderSizePixel = 0
        glow.ZIndex = 2
        glow.Parent = animationLayer
        local corner = Instance.new("UICorner")
        corner.CornerRadius = UDim.new(1, 0)
        corner.Parent = glow
        local gradient = Instance.new("UIGradient")
        gradient.Color = ColorSequence.new(color, COL_ACCENT)
        gradient.Transparency = NumberSequence.new({
            NumberSequenceKeypoint.new(0, 1),
            NumberSequenceKeypoint.new(0.5, 0.18),
            NumberSequenceKeypoint.new(1, 1)
        })
        gradient.Parent = glow
        table.insert(ambientGlows, glow)
        return glow, gradient
    end

    local firstGlow, firstGlowGradient = makeGlow("VoidedXAmbientGlowA", COL_CYAN, UDim2.new(-0.04, 0, 0.02, 0), UDim2.new(0.64, 0, 0.52, 0))
    local secondGlow, secondGlowGradient = makeGlow("VoidedXAmbientGlowB", COL_ACCENT, UDim2.new(0.42, 0, 0.42, 0), UDim2.new(0.62, 0, 0.5, 0))
    local function animateGlow(glow, gradient, duration, endPosition, endSize)
        TweenService:Create(glow, TweenInfo.new(duration, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), {
            Position = endPosition,
            Size = endSize
        }):Play()
        TweenService:Create(gradient, TweenInfo.new(duration * 1.4, Enum.EasingStyle.Linear, Enum.EasingDirection.InOut, -1), {
            Rotation = 180
        }):Play()
    end

    if BACKGROUND_ANIMATION == "orbit" then
        local function orbitGlow(glow, points, duration)
            task.spawn(function()
                local pointIndex = 1
                local pointCount = 0
                for _ in next, points do pointCount = pointCount + 1 end
                while animationLayer.Parent do
                    pointIndex = pointIndex % pointCount + 1
                    local tween = TweenService:Create(glow, TweenInfo.new(duration, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut), {
                        Position = points[pointIndex]
                    })
                    tween:Play()
                    tween.Completed:Wait()
                end
            end)
        end
        orbitGlow(firstGlow, {
            UDim2.new(0.38, 0, 0.02, 0), UDim2.new(0.42, 0, 0.36, 0),
            UDim2.new(0.02, 0, 0.4, 0), UDim2.new(-0.04, 0, 0.02, 0)
        }, 4.2)
        orbitGlow(secondGlow, {
            UDim2.new(0.22, 0, 0.46, 0), UDim2.new(0.03, 0, 0.1, 0),
            UDim2.new(0.42, 0, 0.06, 0), UDim2.new(0.42, 0, 0.42, 0)
        }, 5.1)
    elseif BACKGROUND_ANIMATION == "nebula" then
        animateGlow(firstGlow, firstGlowGradient, 8.5, UDim2.new(0.18, 0, 0.16, 0), UDim2.new(0.78, 0, 0.64, 0))
        animateGlow(secondGlow, secondGlowGradient, 10.5, UDim2.new(0.18, 0, 0.3, 0), UDim2.new(0.74, 0, 0.62, 0))
        TweenService:Create(cardStroke, TweenInfo.new(3.8, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Transparency = 0.32 }):Play()
    elseif BACKGROUND_ANIMATION == "drift" then
        animateGlow(firstGlow, firstGlowGradient, 7.5, UDim2.new(0.3, 0, 0.22, 0), UDim2.new(0.72, 0, 0.56, 0))
        animateGlow(secondGlow, secondGlowGradient, 9, UDim2.new(0.04, 0, 0.34, 0), UDim2.new(0.68, 0, 0.54, 0))
    elseif BACKGROUND_ANIMATION == "aurora" then
        animateGlow(firstGlow, firstGlowGradient, 12, UDim2.new(0.18, 0, 0.28, 0), UDim2.new(0.78, 0, 0.6, 0))
        animateGlow(secondGlow, secondGlowGradient, 10.5, UDim2.new(0.14, 0, 0.12, 0), UDim2.new(0.7, 0, 0.54, 0))
        TweenService:Create(cardStroke, TweenInfo.new(4.2, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Transparency = 0.4 }):Play()
    elseif BACKGROUND_ANIMATION == "pulse" then
        TweenService:Create(firstGlow, TweenInfo.new(2.2, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), {
            BackgroundTransparency = 0.42,
            Size = UDim2.new(0.78, 0, 0.62, 0)
        }):Play()
        TweenService:Create(secondGlow, TweenInfo.new(3, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), {
            BackgroundTransparency = 0.5,
            Position = UDim2.new(0.38, 0, 0.36, 0)
        }):Play()
    elseif BACKGROUND_ANIMATION == "waves" then
        for index = 1, 3 do
            local ribbon = Instance.new("Frame")
            ribbon.Name = "VoidedXWave" .. tostring(index)
            ribbon.Position = UDim2.new(-0.2, 0, 0.18 + index * 0.2, 0)
            ribbon.Size = UDim2.new(1.4, 0, 0, 20 + index * 5)
            ribbon.Rotation = -8
            ribbon.BackgroundColor3 = index % 2 == 0 and COL_ACCENT or COL_CYAN
            ribbon.BackgroundTransparency = 0.78
            ribbon.BorderSizePixel = 0
            ribbon.ZIndex = 2
            ribbon.Parent = animationLayer
            local gradient = Instance.new("UIGradient")
            gradient.Color = ColorSequence.new(COL_CYAN, COL_ACCENT)
            gradient.Transparency = NumberSequence.new({
                NumberSequenceKeypoint.new(0, 1),
                NumberSequenceKeypoint.new(0.5, 0.12),
                NumberSequenceKeypoint.new(1, 1)
            })
            gradient.Parent = ribbon
            TweenService:Create(ribbon, TweenInfo.new(3.8 + index * 0.65, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), {
                Position = UDim2.new(-0.08, 0, 0.08 + index * 0.2, 0),
                Rotation = 8
            }):Play()
        end
    elseif BACKGROUND_ANIMATION == "scanline" or BACKGROUND_ANIMATION == "grid" then
        if BACKGROUND_ANIMATION == "grid" then
            for index = 1, 4 do
                local horizontal = Instance.new("Frame")
                horizontal.Position = UDim2.new(0, 0, index * 0.2, 0)
                horizontal.Size = UDim2.new(1, 0, 0, 1)
                horizontal.BackgroundColor3 = COL_CYAN
                horizontal.BackgroundTransparency = 0.78
                horizontal.BorderSizePixel = 0
                horizontal.ZIndex = 2
                horizontal.Parent = animationLayer
            end
            for index = 1, 5 do
                local vertical = Instance.new("Frame")
                vertical.Position = UDim2.new(index * 0.16, 0, 0, 0)
                vertical.Size = UDim2.new(0, 1, 1, 0)
                vertical.BackgroundColor3 = COL_ACCENT
                vertical.BackgroundTransparency = 0.82
                vertical.BorderSizePixel = 0
                vertical.ZIndex = 2
                vertical.Parent = animationLayer
            end
        end
        local scan = Instance.new("Frame")
        scan.Name = "VoidedXScanline"
        scan.Position = UDim2.new(0, 0, -0.12, 0)
        scan.Size = UDim2.new(1, 0, 0, BACKGROUND_ANIMATION == "grid" and 3 or 5)
        scan.BackgroundColor3 = COL_CYAN
        scan.BackgroundTransparency = 0.45
        scan.BorderSizePixel = 0
        scan.ZIndex = 2
        scan.Parent = animationLayer
        local scanGradient = Instance.new("UIGradient")
        scanGradient.Color = ColorSequence.new(COL_CYAN, COL_ACCENT)
        scanGradient.Transparency = NumberSequence.new({
            NumberSequenceKeypoint.new(0, 0.45),
            NumberSequenceKeypoint.new(0.5, 0.08),
            NumberSequenceKeypoint.new(1, 0.45)
        })
        scanGradient.Parent = scan
        TweenService:Create(scan, TweenInfo.new(BACKGROUND_ANIMATION == "grid" and 5.5 or 3.2, Enum.EasingStyle.Linear, Enum.EasingDirection.InOut, -1), {
            Position = UDim2.new(0, 0, 1.04, 0)
        }):Play()
    elseif BACKGROUND_ANIMATION == "starlight" or BACKGROUND_ANIMATION == "particles" then
        local points = {
            { 0.07, 0.18 }, { 0.18, 0.73 }, { 0.3, 0.3 }, { 0.44, 0.84 },
            { 0.58, 0.16 }, { 0.72, 0.62 }, { 0.86, 0.28 }, { 0.94, 0.8 }
        }
        for index, point in ipairs(points) do
            local dot = Instance.new("Frame")
            dot.Name = (BACKGROUND_ANIMATION == "starlight" and "VoidedXStar" or "VoidedXParticle") .. tostring(index)
            dot.Position = UDim2.new(point[1], 0, point[2], 0)
            local diameter = BACKGROUND_ANIMATION == "starlight" and (index % 3 == 0 and 5 or 3) or (index % 2 == 0 and 5 or 4)
            dot.Size = UDim2.new(0, diameter, 0, diameter)
            dot.BackgroundColor3 = index % 2 == 0 and COL_ACCENT or COL_CYAN
            dot.BackgroundTransparency = 0.18
            dot.BorderSizePixel = 0
            dot.ZIndex = 2
            dot.Parent = animationLayer
            local dotCorner = Instance.new("UICorner")
            dotCorner.CornerRadius = UDim.new(1, 0)
            dotCorner.Parent = dot
            local duration = BACKGROUND_ANIMATION == "starlight" and (1.2 + (index % 4) * 0.45) or (2.4 + (index % 4) * 0.5)
            local offsetX = index % 2 == 0 and 0.035 or -0.035
            local offsetY = index % 2 == 0 and -0.09 or 0.09
            TweenService:Create(dot, TweenInfo.new(duration, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), {
                Position = UDim2.new(math.clamp(point[1] + offsetX, 0.02, 0.96), 0, math.clamp(point[2] + offsetY, 0.04, 0.92), 0),
                BackgroundTransparency = BACKGROUND_ANIMATION == "starlight" and 0.82 or 0.62
            }):Play()
        end
    elseif BACKGROUND_ANIMATION == "shimmer" or BACKGROUND_ANIMATION == "comet" then
        local streak = Instance.new("Frame")
        streak.Name = BACKGROUND_ANIMATION == "comet" and "VoidedXComet" or "VoidedXShimmer"
        streak.Position = UDim2.new(-0.55, 0, BACKGROUND_ANIMATION == "comet" and 0.28 or 0.5, 0)
        streak.Size = UDim2.new(BACKGROUND_ANIMATION == "comet" and 0.42 or 0.36, 0, 1.25, 0)
        streak.Rotation = BACKGROUND_ANIMATION == "comet" and 16 or 9
        streak.BackgroundColor3 = COL_ACCENT
        streak.BackgroundTransparency = 0.35
        streak.BorderSizePixel = 0
        streak.ZIndex = 2
        streak.Parent = animationLayer
        local streakGradient = Instance.new("UIGradient")
        streakGradient.Color = ColorSequence.new(COL_CYAN, COL_ACCENT)
        streakGradient.Transparency = NumberSequence.new({
            NumberSequenceKeypoint.new(0, 1),
            NumberSequenceKeypoint.new(0.38, 0.62),
            NumberSequenceKeypoint.new(0.52, 0.08),
            NumberSequenceKeypoint.new(0.66, 0.62),
            NumberSequenceKeypoint.new(1, 1)
        })
        streakGradient.Parent = streak
        task.spawn(function()
            while animationLayer.Parent do
                streak.Position = UDim2.new(-0.55, 0, BACKGROUND_ANIMATION == "comet" and 0.28 or 0.5, 0)
                streak.BackgroundTransparency = 0.35
                local sweep = TweenService:Create(streak, TweenInfo.new(BACKGROUND_ANIMATION == "comet" and 2.1 or 3.4, Enum.EasingStyle.Linear), {
                    Position = UDim2.new(1.15, 0, BACKGROUND_ANIMATION == "comet" and 0.58 or 0.24, 0),
                    BackgroundTransparency = 0.12
                })
                sweep:Play()
                sweep.Completed:Wait()
                task.wait(BACKGROUND_ANIMATION == "comet" and 0.55 or 0.8)
            end
        end)
    elseif BACKGROUND_ANIMATION == "ripple" then
        task.spawn(function()
            local ringIndex = 0
            while animationLayer.Parent do
                ringIndex = ringIndex % 3 + 1
                local ring = Instance.new("Frame")
                ring.Name = "VoidedXRipple"
                ring.AnchorPoint = Vector2.new(0.5, 0.5)
                ring.Position = UDim2.new(ringIndex == 2 and 0.68 or 0.32, 0, ringIndex == 3 and 0.7 or 0.38, 0)
                ring.Size = UDim2.new(0, 24, 0, 24)
                ring.BackgroundTransparency = 1
                ring.BorderSizePixel = 0
                ring.ZIndex = 2
                ring.Parent = animationLayer
                local ringCorner = Instance.new("UICorner")
                ringCorner.CornerRadius = UDim.new(1, 0)
                ringCorner.Parent = ring
                local ringStroke = Instance.new("UIStroke")
                ringStroke.Color = ringIndex % 2 == 0 and COL_ACCENT or COL_CYAN
                ringStroke.Thickness = 2
                ringStroke.Transparency = 0.2
                ringStroke.Parent = ring
                local expand = TweenService:Create(ring, TweenInfo.new(2.3, Enum.EasingStyle.Sine, Enum.EasingDirection.Out), {
                    Size = UDim2.new(0, 230, 0, 230)
                })
                local fade = TweenService:Create(ringStroke, TweenInfo.new(2.3, Enum.EasingStyle.Sine, Enum.EasingDirection.Out), {
                    Transparency = 1,
                    Thickness = 1
                })
                expand:Play()
                fade:Play()
                task.delay(2.35, function()
                    if ring.Parent then ring:Destroy() end
                end)
                task.wait(0.78)
            end
        end)
    elseif BACKGROUND_ANIMATION == "corners" then
        for index = 1, 4 do
            local x = index % 2 == 0 and 1 or 0
            local y = index > 2 and 1 or 0
            local horizontal = Instance.new("Frame")
            horizontal.AnchorPoint = Vector2.new(x, y)
            horizontal.Position = UDim2.new(x == 1 and 1 or 0, x == 1 and -10 or 10, y == 1 and 1 or 0, y == 1 and -10 or 10)
            horizontal.Size = UDim2.new(0.22, 0, 0, 2)
            horizontal.BackgroundColor3 = index % 2 == 0 and COL_ACCENT or COL_CYAN
            horizontal.BackgroundTransparency = 0.15
            horizontal.BorderSizePixel = 0
            horizontal.ZIndex = 2
            horizontal.Parent = animationLayer
            local vertical = horizontal:Clone()
            vertical.Position = UDim2.new(x == 1 and 1 or 0, x == 1 and -10 or 10, y == 1 and 1 or 0, y == 1 and -10 or 10)
            vertical.Size = UDim2.new(0, 2, 0, 42)
            vertical.Parent = animationLayer
            TweenService:Create(horizontal, TweenInfo.new(1.6 + index * 0.18, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { BackgroundTransparency = 0.62 }):Play()
            TweenService:Create(vertical, TweenInfo.new(1.6 + index * 0.18, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { BackgroundTransparency = 0.62 }):Play()
        end
    else
        animateGlow(firstGlow, firstGlowGradient, 8, UDim2.new(0.24, 0, 0.18, 0), UDim2.new(0.72, 0, 0.56, 0))
        animateGlow(secondGlow, secondGlowGradient, 9.5, UDim2.new(0.04, 0, 0.36, 0), UDim2.new(0.68, 0, 0.54, 0))
    end
end

local uiScale = Instance.new("UIScale")
uiScale.Scale = 0.86
uiScale.Parent = card

local topLine = Instance.new("Frame")
topLine.AnchorPoint = Vector2.new(0.5, 0)
topLine.Position = UDim2.new(0.5, 0, 0, 0)
topLine.Size = UDim2.new(0, 0, 0, 2)
topLine.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
topLine.BorderSizePixel = 0
topLine.ZIndex = 6
topLine.Parent = card
local topLineCorner = Instance.new("UICorner")
topLineCorner.CornerRadius = UDim.new(1, 0)
topLineCorner.Parent = topLine
local topLineGradient = Instance.new("UIGradient")
topLineGradient.Color = ColorSequence.new(COL_CYAN, COL_ACCENT)
topLineGradient.Parent = topLine
TweenService:Create(topLine, TweenInfo.new(0.7, EASE_OUT, Enum.EasingDirection.Out, 0, false, 0.12), { Size = UDim2.new(0.72, 0, 0, 2) }):Play()

local content = Instance.new("Frame")
content.Size = UDim2.fromOffset(cardWidth, CARD_BASE_HEIGHT)
content.BackgroundTransparency = 1
content.ZIndex = 3
content.Parent = card

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 22)
padding.PaddingBottom = UDim.new(0, 18)
padding.PaddingLeft = UDim.new(0, 22)
padding.PaddingRight = UDim.new(0, 22)
padding.Parent = content

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 10)
layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = content

local watchedCamera = nil
local applyHeader = nil
local function applyLayout()
    local activeCamera = camera
    if not (activeCamera and activeCamera.Parent) then activeCamera = workspace.CurrentCamera end
    if activeCamera then camera = activeCamera end
    local viewport = nil
    if activeCamera then
        local size = activeCamera.ViewportSize
        if size and size.X > 0 and size.Y > 0 then viewport = size end
    end
    if not viewport then
        local guiSize = screenGui.AbsoluteSize
        if guiSize and guiSize.X > 0 and guiSize.Y > 0 then viewport = guiSize end
    end
    if not viewport then viewport = Vector2.new(1280, 720) end
    -- Phones get a smaller card so the panel does not swallow the game view.
    local phone = touchDevice and math.min(viewport.X, viewport.Y) < 560
    phoneLayout = phone
    cardScale = math.clamp(math.min(viewport.X / (phone and 520 or 470), viewport.Y / 660), phone and 0.6 or 0.68, 1)
    cardWidth = math.clamp(math.floor((viewport.X - (phone and 20 or 28) * cardScale) / cardScale), 240, phone and 350 or 430)
    local height = CARD_BASE_HEIGHT + statusHeight
    card.Size = UDim2.fromOffset(cardWidth, height)
    content.Size = UDim2.fromOffset(cardWidth, height)
    uiScale.Scale = cardScale
    if applyHeader then applyHeader(phone) end
end
local function watchCamera()
    local activeCamera = workspace.CurrentCamera
    if not activeCamera or activeCamera == watchedCamera then return end
    watchedCamera = activeCamera
    camera = activeCamera
    pcall(function()
        activeCamera:GetPropertyChangedSignal("ViewportSize"):Connect(applyLayout)
    end)
end
watchCamera()
pcall(function()
    workspace:GetPropertyChangedSignal("CurrentCamera"):Connect(function()
        watchCamera()
        applyLayout()
    end)
    screenGui:GetPropertyChangedSignal("AbsoluteSize"):Connect(applyLayout)
end)
applyLayout()
uiScale.Scale = cardScale * 0.86
TweenService:Create(uiScale, TweenInfo.new(0.55, EASE_BACK), { Scale = cardScale }):Play()
TweenService:Create(card, TweenInfo.new(0.48, EASE_OUT), {
    Position = UDim2.new(0.5, 0, 0.5, 0)
}):Play()
TweenService:Create(cardStroke, TweenInfo.new(0.5, EASE_OUT), { Transparency = 0.55 }):Play()

local header = Instance.new("Frame")
header.Size = UDim2.new(1, 0, 0, 52)
header.BackgroundTransparency = 1
header.LayoutOrder = 1
header.Parent = content

local brand = Instance.new("Frame")
brand.Size = UDim2.new(0, 48, 0, 48)
brand.Position = UDim2.new(0, 0, 0, 2)
brand.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
brand.BorderSizePixel = 0
brand.ZIndex = 4
brand.Parent = header
local brandCorner = Instance.new("UICorner")
brandCorner.CornerRadius = UDim.new(0, 14)
brandCorner.Parent = brand
local brandGradient = Instance.new("UIGradient")
brandGradient.Rotation = 45
brandGradient.Color = ColorSequence.new(COL_CYAN, COL_ACCENT)
brandGradient.Parent = brand
local brandStroke = Instance.new("UIStroke")
brandStroke.Color = COL_CYAN
brandStroke.Thickness = 1
brandStroke.Transparency = 0.45
brandStroke.Parent = brand
local brandLetter = Instance.new("TextLabel")
brandLetter.Size = UDim2.fromScale(1, 1)
brandLetter.BackgroundTransparency = 1
brandLetter.Text = "V"
brandLetter.TextColor3 = COL_INK
brandLetter.Font = Enum.Font.GothamBold
brandLetter.TextSize = 22
brandLetter.ZIndex = 5
brandLetter.Parent = brand
local brandScale = Instance.new("UIScale")
brandScale.Scale = 0.4
brandScale.Parent = brand
TweenService:Create(brandScale, TweenInfo.new(0.65, EASE_BACK, Enum.EasingDirection.Out, 0, false, 0.08), { Scale = 1 }):Play()
task.spawn(function()
    while brand.Parent do
        local breathe = TweenService:Create(brandScale, TweenInfo.new(1.9, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, 0, true), { Scale = 1.045 })
        breathe:Play()
        breathe.Completed:Wait()
    end
end)

local eyebrow = Instance.new("TextLabel")
eyebrow.Position = UDim2.new(0, 60, 0, 0)
eyebrow.Size = UDim2.new(1, -186, 0, 10)
eyebrow.BackgroundTransparency = 1
eyebrow.Text = "VOIDEDX // SECURE ACCESS"
eyebrow.TextColor3 = COL_CYAN
eyebrow.Font = Enum.Font.GothamBold
eyebrow.TextSize = 8
eyebrow.TextXAlignment = Enum.TextXAlignment.Left
eyebrow.ZIndex = 4
eyebrow.Parent = header

local title = Instance.new("TextLabel")
title.Position = UDim2.new(0, 60, 0, 11)
title.Size = UDim2.new(1, -186, 0, 21)
title.BackgroundTransparency = 1
title.Text = ${luaString(appearance.title)}
title.TextColor3 = COL_TEXT
title.Font = Enum.Font.GothamBold
title.TextSize = 15
title.TextTruncate = Enum.TextTruncate.AtEnd
title.TextXAlignment = Enum.TextXAlignment.Left
title.ZIndex = 4
title.Parent = header

local subtitle = Instance.new("TextLabel")
subtitle.Position = UDim2.new(0, 60, 0, 33)
subtitle.Size = UDim2.new(1, -186, 0, 13)
subtitle.BackgroundTransparency = 1
subtitle.Text = ${luaString(appearance.subtitle)}
subtitle.TextColor3 = COL_MUTED
subtitle.Font = Enum.Font.Gotham
subtitle.TextSize = 10
subtitle.TextTruncate = Enum.TextTruncate.AtEnd
subtitle.TextXAlignment = Enum.TextXAlignment.Left
subtitle.ZIndex = 4
subtitle.Parent = header

local stateChip = Instance.new("Frame")
stateChip.AnchorPoint = Vector2.new(1, 0)
stateChip.Position = UDim2.new(1, -34, 0, 1)
stateChip.Size = UDim2.new(0, 78, 0, 22)
stateChip.BackgroundColor3 = COL_INPUT
stateChip.BackgroundTransparency = 0.25
stateChip.BorderSizePixel = 0
stateChip.ZIndex = 4
stateChip.Parent = header
local stateChipCorner = Instance.new("UICorner")
stateChipCorner.CornerRadius = UDim.new(1, 0)
stateChipCorner.Parent = stateChip
local stateChipStroke = Instance.new("UIStroke")
stateChipStroke.Color = COL_LINE
stateChipStroke.Thickness = 1
stateChipStroke.Transparency = 0.35
stateChipStroke.Parent = stateChip
local stateDot = Instance.new("Frame")
stateDot.Position = UDim2.new(0, 9, 0.5, -2)
stateDot.Size = UDim2.new(0, 5, 0, 5)
stateDot.BackgroundColor3 = COL_SUCCESS
stateDot.BorderSizePixel = 0
stateDot.ZIndex = 5
stateDot.Parent = stateChip
local stateDotCorner = Instance.new("UICorner")
stateDotCorner.CornerRadius = UDim.new(1, 0)
stateDotCorner.Parent = stateDot
local stateLabel = Instance.new("TextLabel")
stateLabel.Position = UDim2.new(0, 20, 0, 0)
stateLabel.Size = UDim2.new(1, -26, 1, 0)
stateLabel.BackgroundTransparency = 1
stateLabel.Text = "SECURE"
stateLabel.TextColor3 = COL_SUCCESS
stateLabel.Font = Enum.Font.GothamBold
stateLabel.TextSize = 7
stateLabel.TextXAlignment = Enum.TextXAlignment.Left
stateLabel.ZIndex = 5
stateLabel.Parent = stateChip
task.spawn(function()
    while stateDot.Parent do
        local blink = TweenService:Create(stateDot, TweenInfo.new(0.9, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut), { BackgroundTransparency = 0.75 })
        blink:Play()
        blink.Completed:Wait()
        local back = TweenService:Create(stateDot, TweenInfo.new(0.9, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut), { BackgroundTransparency = 0 })
        back:Play()
        back.Completed:Wait()
    end
end)

applyHeader = function(phone)
    -- Narrow phone cards drop the seal chip so the title is not truncated.
    local inset = phone and 110 or 186
    eyebrow.Size = UDim2.new(1, -inset, 0, 10)
    title.Size = UDim2.new(1, -inset, 0, 21)
    subtitle.Size = UDim2.new(1, -inset, 0, 13)
    stateChip.Visible = not phone
end
applyHeader(phoneLayout)

local vaultPill = Instance.new("Frame")
vaultPill.Size = UDim2.new(1, 0, 0, 34)
vaultPill.BackgroundColor3 = COL_INPUT
vaultPill.BackgroundTransparency = 0.15
vaultPill.BorderSizePixel = 0
vaultPill.LayoutOrder = 2
vaultPill.Parent = content
local vaultPillCorner = Instance.new("UICorner")
vaultPillCorner.CornerRadius = UDim.new(0, 10)
vaultPillCorner.Parent = vaultPill
local vaultPillStroke = Instance.new("UIStroke")
vaultPillStroke.Color = COL_LINE
vaultPillStroke.Thickness = 1
vaultPillStroke.Transparency = 0.3
vaultPillStroke.Parent = vaultPill
local vaultDot = Instance.new("Frame")
vaultDot.Position = UDim2.new(0, 12, 0.5, -3)
vaultDot.Size = UDim2.new(0, 6, 0, 6)
vaultDot.BackgroundColor3 = COL_CYAN
vaultDot.BorderSizePixel = 0
vaultDot.ZIndex = 4
vaultDot.Parent = vaultPill
local vaultDotCorner = Instance.new("UICorner")
vaultDotCorner.CornerRadius = UDim.new(1, 0)
vaultDotCorner.Parent = vaultDot
local vaultTag = Instance.new("TextLabel")
vaultTag.AnchorPoint = Vector2.new(1, 0.5)
vaultTag.Position = UDim2.new(1, -12, 0.5, 0)
vaultTag.Size = UDim2.new(0, 44, 0, 12)
vaultTag.BackgroundTransparency = 1
vaultTag.Text = "VAULT"
vaultTag.TextColor3 = COL_MUTED
vaultTag.Font = Enum.Font.GothamBold
vaultTag.TextSize = 7
vaultTag.TextXAlignment = Enum.TextXAlignment.Right
vaultTag.ZIndex = 4
vaultTag.Parent = vaultPill
local vaultNameLabel = Instance.new("TextLabel")
vaultNameLabel.Position = UDim2.new(0, 26, 0, 0)
vaultNameLabel.Size = UDim2.new(1, -84, 1, 0)
vaultNameLabel.BackgroundTransparency = 1
vaultNameLabel.Text = ${luaString(vaultName)}
vaultNameLabel.TextColor3 = COL_TEXT
vaultNameLabel.Font = Enum.Font.GothamSemibold
vaultNameLabel.TextSize = 11
vaultNameLabel.TextTruncate = Enum.TextTruncate.AtEnd
vaultNameLabel.TextXAlignment = Enum.TextXAlignment.Left
vaultNameLabel.TextYAlignment = Enum.TextYAlignment.Center
vaultNameLabel.ZIndex = 4
vaultNameLabel.Parent = vaultPill

local captionRow = Instance.new("Frame")
captionRow.Size = UDim2.new(1, 0, 0, 11)
captionRow.BackgroundTransparency = 1
captionRow.LayoutOrder = 3
captionRow.Parent = content
local inputCaption = Instance.new("TextLabel")
inputCaption.Size = UDim2.new(0.6, 0, 1, 0)
inputCaption.BackgroundTransparency = 1
inputCaption.Text = "ACCESS KEY"
inputCaption.TextColor3 = COL_MUTED
inputCaption.Font = Enum.Font.GothamBold
inputCaption.TextSize = 8
inputCaption.TextXAlignment = Enum.TextXAlignment.Left
inputCaption.Parent = captionRow
local captionHint = Instance.new("TextLabel")
captionHint.AnchorPoint = Vector2.new(1, 0)
captionHint.Position = UDim2.new(1, 0, 0, 0)
captionHint.Size = UDim2.new(0.4, 0, 1, 0)
captionHint.BackgroundTransparency = 1
captionHint.Text = "ENCRYPTED"
captionHint.TextColor3 = COL_CYAN
captionHint.Font = Enum.Font.GothamBold
captionHint.TextSize = 7
captionHint.TextXAlignment = Enum.TextXAlignment.Right
captionHint.Parent = captionRow

local inputHolder = Instance.new("Frame")
inputHolder.Size = UDim2.new(1, 0, 0, 48)
inputHolder.BackgroundTransparency = 1
inputHolder.LayoutOrder = 4
inputHolder.Parent = content

local inputGlow = Instance.new("Frame")
inputGlow.Size = UDim2.new(1, 6, 1, 6)
inputGlow.Position = UDim2.new(0, -3, 0, -3)
inputGlow.BackgroundColor3 = COL_CYAN
inputGlow.BackgroundTransparency = 1
inputGlow.BorderSizePixel = 0
inputGlow.ZIndex = 3
inputGlow.Parent = inputHolder
local inputGlowCorner = Instance.new("UICorner")
inputGlowCorner.CornerRadius = UDim.new(0, 13)
inputGlowCorner.Parent = inputGlow

local inputBox = Instance.new("TextBox")
inputBox.Size = UDim2.fromScale(1, 1)
inputBox.BackgroundColor3 = COL_INPUT
inputBox.BackgroundTransparency = 0.05
inputBox.TextColor3 = COL_TEXT
inputBox.PlaceholderText = "Paste your access key"
inputBox.PlaceholderColor3 = COL_MUTED
inputBox.Text = ""
inputBox.ClearTextOnFocus = false
inputBox.Font = Enum.Font.Code
inputBox.TextSize = 13
inputBox.TextXAlignment = Enum.TextXAlignment.Left
inputBox.ZIndex = 4
inputBox.Parent = inputHolder
local inputCorner = Instance.new("UICorner")
inputCorner.CornerRadius = UDim.new(0, 11)
inputCorner.Parent = inputBox
local inputStroke = Instance.new("UIStroke")
inputStroke.Color = COL_LINE
inputStroke.Thickness = 1
inputStroke.Transparency = 0.25
inputStroke.Parent = inputBox
local inputPad = Instance.new("UIPadding")
inputPad.PaddingLeft = UDim.new(0, 13)
inputPad.PaddingRight = UDim.new(0, 13)
inputPad.Parent = inputBox
local inputTick = Instance.new("Frame")
inputTick.AnchorPoint = Vector2.new(0, 0.5)
inputTick.Position = UDim2.new(0, 0, 0.5, 0)
inputTick.Size = UDim2.new(0, 2, 0, 0)
inputTick.BackgroundColor3 = COL_CYAN
inputTick.BorderSizePixel = 0
inputTick.ZIndex = 5
inputTick.Parent = inputBox
local inputTickCorner = Instance.new("UICorner")
inputTickCorner.CornerRadius = UDim.new(1, 0)
inputTickCorner.Parent = inputTick

inputBox.Focused:Connect(function()
    TweenService:Create(inputStroke, TweenInfo.new(0.2, EASE_OUT), { Color = COL_CYAN, Thickness = 2, Transparency = 0.1 }):Play()
    TweenService:Create(inputTick, TweenInfo.new(0.2, EASE_OUT), { Size = UDim2.new(0, 2, 0, 22) }):Play()
    TweenService:Create(inputGlow, TweenInfo.new(0.25, EASE_OUT), { BackgroundTransparency = 0.88 }):Play()
end)
inputBox.FocusLost:Connect(function()
    TweenService:Create(inputStroke, TweenInfo.new(0.2, EASE_OUT), { Color = COL_LINE, Thickness = 1, Transparency = 0.25 }):Play()
    TweenService:Create(inputTick, TweenInfo.new(0.2, EASE_OUT), { Size = UDim2.new(0, 2, 0, 0) }):Play()
    TweenService:Create(inputGlow, TweenInfo.new(0.25, EASE_OUT), { BackgroundTransparency = 1 }):Play()
end)

local submitBtn = Instance.new("TextButton")
submitBtn.Size = UDim2.new(1, 0, 0, 50)
submitBtn.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
submitBtn.Text = ""
submitBtn.AutoButtonColor = false
submitBtn.ZIndex = 4
submitBtn.LayoutOrder = 5
submitBtn.Parent = content
local btnCorner = Instance.new("UICorner")
btnCorner.CornerRadius = UDim.new(0, 11)
btnCorner.Parent = submitBtn
local btnGradient = Instance.new("UIGradient")
btnGradient.Rotation = 35
btnGradient.Color = ColorSequence.new(COL_CYAN, COL_ACCENT)
btnGradient.Parent = submitBtn
local btnStroke = Instance.new("UIStroke")
btnStroke.Color = Color3.fromRGB(255, 255, 255)
btnStroke.Thickness = 1
btnStroke.Transparency = 0.72
btnStroke.Parent = submitBtn

local submitLabel = Instance.new("TextLabel")
submitLabel.Position = UDim2.new(0, 16, 0, 0)
submitLabel.Size = UDim2.new(1, -112, 1, 0)
submitLabel.BackgroundTransparency = 1
submitLabel.Text = ${luaString(appearance.buttonLabel)}
submitLabel.TextColor3 = COL_INK
submitLabel.Font = Enum.Font.GothamBold
submitLabel.TextSize = 13
submitLabel.TextXAlignment = Enum.TextXAlignment.Left
submitLabel.TextYAlignment = Enum.TextYAlignment.Center
submitLabel.TextTruncate = Enum.TextTruncate.AtEnd
submitLabel.ZIndex = 5
submitLabel.Parent = submitBtn

local submitHint = Instance.new("TextLabel")
submitHint.AnchorPoint = Vector2.new(1, 0.5)
submitHint.Position = UDim2.new(1, -50, 0.5, 0)
submitHint.Size = UDim2.new(0, 40, 0, 10)
submitHint.BackgroundTransparency = 1
submitHint.Text = "ENTER"
submitHint.TextColor3 = COL_INK
submitHint.TextTransparency = 0.45
submitHint.Font = Enum.Font.GothamBold
submitHint.TextSize = 7
submitHint.TextXAlignment = Enum.TextXAlignment.Right
submitHint.ZIndex = 5
submitHint.Parent = submitBtn

local arrowBadge = Instance.new("Frame")
arrowBadge.AnchorPoint = Vector2.new(1, 0.5)
arrowBadge.Position = UDim2.new(1, -10, 0.5, 0)
arrowBadge.Size = UDim2.new(0, 26, 0, 26)
arrowBadge.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
arrowBadge.BackgroundTransparency = 0.78
arrowBadge.BorderSizePixel = 0
arrowBadge.ZIndex = 5
arrowBadge.Parent = submitBtn
local arrowCorner = Instance.new("UICorner")
arrowCorner.CornerRadius = UDim.new(0, 8)
arrowCorner.Parent = arrowBadge
local submitArrow = Instance.new("TextLabel")
submitArrow.Size = UDim2.fromScale(1, 1)
submitArrow.BackgroundTransparency = 1
submitArrow.Text = "→"
submitArrow.TextColor3 = COL_INK
submitArrow.TextSize = 15
submitArrow.Font = Enum.Font.GothamBold
submitArrow.ZIndex = 6
submitArrow.Parent = arrowBadge

local shine = Instance.new("Frame")
shine.Size = UDim2.new(0, 54, 1, 46)
shine.Position = UDim2.new(0, -90, 0.5, -40)
shine.Rotation = 18
shine.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
shine.BackgroundTransparency = 0.86
shine.BorderSizePixel = 0
shine.ZIndex = 4
shine.Parent = submitBtn
local shineGradient = Instance.new("UIGradient")
shineGradient.Transparency = NumberSequence.new({
    NumberSequenceKeypoint.new(0, 1),
    NumberSequenceKeypoint.new(0.5, 0.2),
    NumberSequenceKeypoint.new(1, 1)
})
shineGradient.Parent = shine

local btnScale = Instance.new("UIScale")
btnScale.Parent = submitBtn

local shining = false
local function slideShine()
    if shining then return end
    shining = true
    task.spawn(function()
        while shining and submitBtn.Parent do
            shine.Position = UDim2.new(0, -90, 0.5, -40)
            local sweep = TweenService:Create(shine, TweenInfo.new(0.65, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
                Position = UDim2.new(1, 20, 0.5, -40)
            })
            sweep:Play()
            sweep.Completed:Wait()
            task.wait(0.3)
        end
    end)
end
submitBtn.MouseEnter:Connect(function()
    TweenService:Create(btnScale, TweenInfo.new(0.15, EASE_OUT), { Scale = 1.012 }):Play()
    TweenService:Create(btnStroke, TweenInfo.new(0.15, EASE_OUT), { Transparency = 0.4 }):Play()
    slideShine()
end)
submitBtn.MouseLeave:Connect(function()
    shining = false
    TweenService:Create(btnScale, TweenInfo.new(0.15, EASE_OUT), { Scale = 1 }):Play()
    TweenService:Create(btnStroke, TweenInfo.new(0.15, EASE_OUT), { Transparency = 0.72 }):Play()
end)
submitBtn.MouseButton1Down:Connect(function()
    TweenService:Create(btnScale, TweenInfo.new(0.08, EASE_OUT), { Scale = 0.975 }):Play()
end)
submitBtn.MouseButton1Up:Connect(function()
    TweenService:Create(btnScale, TweenInfo.new(0.12, EASE_OUT), { Scale = 1.012 }):Play()
end)

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, 0, 0, 0)
statusLabel.BackgroundTransparency = 1
statusLabel.Text = ""
statusLabel.TextColor3 = COL_DANGER
statusLabel.Font = Enum.Font.Gotham
statusLabel.TextSize = 10
statusLabel.TextWrapped = true
statusLabel.TextTransparency = 1
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.TextYAlignment = Enum.TextYAlignment.Top
statusLabel.LayoutOrder = 6
statusLabel.Parent = content

local footerRow = Instance.new("Frame")
footerRow.Size = UDim2.new(1, 0, 0, 32)
footerRow.BackgroundTransparency = 1
footerRow.LayoutOrder = 7
footerRow.Parent = content

local getKeyBtn = Instance.new("TextButton")
getKeyBtn.Size = UDim2.new(1, -104, 1, 0)
getKeyBtn.BackgroundColor3 = COL_PANEL
getKeyBtn.BackgroundTransparency = 0.15
getKeyBtn.Text = "↗  Get a key"
getKeyBtn.TextColor3 = COL_TEXT
getKeyBtn.Font = Enum.Font.GothamSemibold
getKeyBtn.TextSize = 10
getKeyBtn.AutoButtonColor = false
getKeyBtn.ZIndex = 4
getKeyBtn.Parent = footerRow
local getKeyCorner = Instance.new("UICorner")
getKeyCorner.CornerRadius = UDim.new(0, 9)
getKeyCorner.Parent = getKeyBtn
local getKeyStroke = Instance.new("UIStroke")
getKeyStroke.Color = COL_LINE
getKeyStroke.Thickness = 1
getKeyStroke.Transparency = 0.3
getKeyStroke.Parent = getKeyBtn
local getKeyScale = Instance.new("UIScale")
getKeyScale.Parent = getKeyBtn
getKeyBtn.MouseEnter:Connect(function()
    TweenService:Create(getKeyScale, TweenInfo.new(0.14, EASE_OUT), { Scale = 1.015 }):Play()
    TweenService:Create(getKeyStroke, TweenInfo.new(0.14, EASE_OUT), { Color = COL_CYAN, Transparency = 0 }):Play()
end)
getKeyBtn.MouseLeave:Connect(function()
    TweenService:Create(getKeyScale, TweenInfo.new(0.14, EASE_OUT), { Scale = 1 }):Play()
    TweenService:Create(getKeyStroke, TweenInfo.new(0.14, EASE_OUT), { Color = COL_LINE, Transparency = 0.3 }):Play()
end)

local siteLabel = Instance.new("TextLabel")
siteLabel.AnchorPoint = Vector2.new(1, 0.5)
siteLabel.Position = UDim2.new(1, 0, 0.5, 0)
siteLabel.Size = UDim2.new(0, 98, 0, 12)
siteLabel.BackgroundTransparency = 1
siteLabel.Text = "voidedx.vercel.app"
siteLabel.TextColor3 = COL_MUTED
siteLabel.TextTransparency = 0.15
siteLabel.Font = Enum.Font.GothamBold
siteLabel.TextSize = 8
siteLabel.TextXAlignment = Enum.TextXAlignment.Right
siteLabel.Parent = footerRow

local footerNote = Instance.new("TextLabel")
footerNote.Size = UDim2.new(1, 0, 0, 9)
footerNote.BackgroundTransparency = 1
footerNote.Text = "PROTECTED BY VOIDEDX ARMOR"
footerNote.TextColor3 = COL_MUTED
footerNote.TextTransparency = 0.3
footerNote.Font = Enum.Font.GothamBold
footerNote.TextSize = 7
footerNote.LayoutOrder = 8
footerNote.Parent = content

local closeButton = Instance.new("TextButton")
closeButton.AnchorPoint = Vector2.new(1, 0)
closeButton.Position = UDim2.new(1, -14, 0, 14)
closeButton.Size = UDim2.new(0, 26, 0, 26)
closeButton.BackgroundColor3 = COL_INPUT
closeButton.BackgroundTransparency = 0.2
closeButton.Text = "×"
closeButton.TextColor3 = COL_MUTED
closeButton.TextSize = 18
closeButton.Font = Enum.Font.Gotham
closeButton.AutoButtonColor = false
closeButton.ZIndex = 8
closeButton.Parent = card
local closeCorner = Instance.new("UICorner")
closeCorner.CornerRadius = UDim.new(0, 8)
closeCorner.Parent = closeButton
local closeStroke = Instance.new("UIStroke")
closeStroke.Color = COL_LINE
closeStroke.Thickness = 1
closeStroke.Transparency = 0.4
closeStroke.Parent = closeButton
local closeScale = Instance.new("UIScale")
closeScale.Parent = closeButton
closeButton.MouseEnter:Connect(function()
    TweenService:Create(closeScale, TweenInfo.new(0.15, EASE_OUT), { Scale = 1.1 }):Play()
    TweenService:Create(closeStroke, TweenInfo.new(0.15, EASE_OUT), { Color = COL_CYAN, Transparency = 0.1 }):Play()
    TweenService:Create(closeButton, TweenInfo.new(0.2, EASE_OUT), { Rotation = 90 }):Play()
end)
closeButton.MouseLeave:Connect(function()
    TweenService:Create(closeScale, TweenInfo.new(0.15, EASE_OUT), { Scale = 1 }):Play()
    TweenService:Create(closeStroke, TweenInfo.new(0.15, EASE_OUT), { Color = COL_LINE, Transparency = 0.4 }):Play()
    TweenService:Create(closeButton, TweenInfo.new(0.2, EASE_OUT), { Rotation = 0 }):Play()
end)
closeButton.Activated:Connect(function()
    closeButton.Active = false
    TweenService:Create(uiScale, TweenInfo.new(0.2, EASE_OUT), { Scale = cardScale * 0.94 }):Play()
    TweenService:Create(card, TweenInfo.new(0.24, EASE_OUT), {
        BackgroundTransparency = 1,
        Position = UDim2.new(0.5, 0, 0.5, 16)
    }):Play()
    TweenService:Create(cardStroke, TweenInfo.new(0.18, EASE_OUT), { Transparency = 1 }):Play()
    TweenService:Create(overlay, TweenInfo.new(0.22, EASE_OUT), { BackgroundTransparency = 1 }):Play()
    task.wait(0.22)
    if screenGui.Parent then screenGui:Destroy() end
end)

local introTexts = { eyebrow, title, subtitle, vaultNameLabel, vaultTag, inputCaption, captionHint, submitLabel, submitHint, statusLabel, footerNote, siteLabel, stateLabel }
for _, textObject in ipairs(introTexts) do
    if textObject.TextTransparency == 0 then textObject.TextTransparency = 1 end
end
local introFrames = { vaultPill, inputBox, submitBtn, getKeyBtn, stateChip }
for _, frameObject in ipairs(introFrames) do
    frameObject.BackgroundTransparency = 1
end
task.spawn(function()
    task.wait(0.16)
    for index = 1, #introTexts do
        local textObject = introTexts[index]
        if textObject.Parent then
            TweenService:Create(textObject, TweenInfo.new(0.24, EASE_OUT), { TextTransparency = textObject == siteLabel and 0.15 or (textObject == footerNote and 0.3 or (textObject == submitHint and 0.45 or 0)) }):Play()
        end
        task.wait(0.028)
    end
    for _, frameObject in ipairs(introFrames) do
        if frameObject.Parent then
            local target = frameObject == submitBtn and 0 or (frameObject == stateChip and 0.25 or (frameObject == inputBox and 0.05 or 0.15))
            TweenService:Create(frameObject, TweenInfo.new(0.3, EASE_OUT), { BackgroundTransparency = target }):Play()
        end
        task.wait(0.04)
    end
end)

local function measureStatus(text)
    if type(text) ~= "string" or text == "" then return 0 end
    local availableWidth = math.max(120, cardWidth - 44)
    local ok, bounds = pcall(function()
        return TextService:GetTextSize(text, 10, Enum.Font.Gotham, Vector2.new(availableWidth, 1000))
    end)
    if ok and bounds and type(bounds.Y) == "number" then
        return math.max(12, math.ceil(bounds.Y))
    end
    return 14
end

local function setStatus(text, color)
    statusLabel.Text = text
    statusLabel.TextColor3 = color
    statusLabel.TextTransparency = 1
    local measured = measureStatus(text)
    if measured ~= statusHeight then
        statusHeight = measured
        statusLabel.Size = UDim2.new(1, 0, 0, measured)
        applyLayout()
    end
    if text ~= "" then
        TweenService:Create(statusLabel, TweenInfo.new(0.2, EASE_OUT), { TextTransparency = 0 }):Play()
    end
end

local function formatKeyTime(seconds)
    seconds = math.max(0, math.floor(seconds))
    local days = math.floor(seconds / 86400)
    local hours = math.floor((seconds % 86400) / 3600)
    local minutes = math.floor((seconds % 3600) / 60)
    local years = math.floor(days / 365)
    days = days % 365
    local parts = {}
    if years > 0 then table.insert(parts, string.format("%dy", years)) end
    if days > 0 then table.insert(parts, string.format("%dd", days)) end
    if hours > 0 then table.insert(parts, string.format("%dh", hours)) end
    if minutes > 0 then table.insert(parts, string.format("%dm", minutes)) end
    if next(parts) == nil then return string.format("%ds", seconds) end
    return table.concat(parts, " ")
end

local function formatClock(seconds)
    seconds = math.max(0, math.floor(seconds))
    local days = math.floor(seconds / 86400)
    local hours = math.floor((seconds % 86400) / 3600)
    local minutes = math.floor((seconds % 3600) / 60)
    local secs = seconds % 60
    if days > 0 then return string.format("%dd %02d:%02d:%02d", days, hours, minutes, secs) end
    return string.format("%02d:%02d:%02d", hours, minutes, secs)
end

local function showKeyTimer(remainingSeconds, fileSaved, expiresAtMs)
    screenGui.Name = "VoidedXKeyStatus"

    local camera = workspace.CurrentCamera
    local viewportSize = camera and camera.ViewportSize or Vector2.new(1280, 720)
    local touchPanel = touchDevice and math.min(viewportSize.X, viewportSize.Y) < 560
    local panelWidth = math.max(200, math.min(touchPanel and 260 or 320, viewportSize.X - 28))
    local panel = Instance.new("Frame")
    local panelStart = UDim2.new(1, -14, 1, 22)
    local panelRest = UDim2.new(1, -14, 1, -14)
    if touchPanel then
        -- Keep the status card off the mobile jump/thumbstick corners.
        panel.AnchorPoint = Vector2.new(0.5, 0)
        panelStart = UDim2.new(0.5, 0, 0, -10)
        panelRest = UDim2.new(0.5, 0, 0, 14)
    else
        panel.AnchorPoint = Vector2.new(1, 1)
    end
    panel.Position = panelStart
    panel.Size = UDim2.new(0, panelWidth, 0, 108)
    panel.BackgroundColor3 = COL_DEEP
    panel.BackgroundTransparency = 1
    panel.BorderSizePixel = 0
    panel.Parent = screenGui
    local panelCorner = Instance.new("UICorner")
    panelCorner.CornerRadius = UDim.new(0, 14)
    panelCorner.Parent = panel
    local panelStroke = Instance.new("UIStroke")
    panelStroke.Color = COL_CYAN
    panelStroke.Thickness = 1
    panelStroke.Transparency = 1
    panelStroke.Parent = panel
    local panelGradient = Instance.new("UIGradient")
    panelGradient.Rotation = 100
    panelGradient.Color = ColorSequence.new(COL_DEEP, COL_BG:Lerp(COL_ACCENT, 0.08))
    panelGradient.Parent = panel
    local panelScale = Instance.new("UIScale")
    panelScale.Scale = 0.92
    panelScale.Parent = panel
    TweenService:Create(panel, TweenInfo.new(0.38, EASE_OUT), {
        Position = panelRest,
        BackgroundTransparency = 0.06
    }):Play()
    TweenService:Create(panelStroke, TweenInfo.new(0.32, EASE_OUT), { Transparency = 0.3 }):Play()
    TweenService:Create(panelScale, TweenInfo.new(0.42, EASE_BACK), { Scale = 1 }):Play()

    local accentLine = Instance.new("Frame")
    accentLine.AnchorPoint = Vector2.new(0.5, 0)
    accentLine.Position = UDim2.new(0.5, 0, 0, 0)
    accentLine.Size = UDim2.new(0.55, 0, 0, 2)
    accentLine.BackgroundColor3 = COL_SUCCESS
    accentLine.BorderSizePixel = 0
    accentLine.Parent = panel
    local accentLineCorner = Instance.new("UICorner")
    accentLineCorner.CornerRadius = UDim.new(1, 0)
    accentLineCorner.Parent = accentLine
    local accentLineGradient = Instance.new("UIGradient")
    accentLineGradient.Color = ColorSequence.new(COL_SUCCESS, COL_CYAN)
    accentLineGradient.Parent = accentLine

    local nameDot = Instance.new("Frame")
    nameDot.Position = UDim2.new(0, 14, 0, 14)
    nameDot.Size = UDim2.new(0, 6, 0, 6)
    nameDot.BackgroundColor3 = COL_SUCCESS
    nameDot.BorderSizePixel = 0
    nameDot.Parent = panel
    local nameDotCorner = Instance.new("UICorner")
    nameDotCorner.CornerRadius = UDim.new(1, 0)
    nameDotCorner.Parent = nameDot

    local nameLabel = Instance.new("TextLabel")
    nameLabel.Position = UDim2.new(0, 26, 0, 8)
    nameLabel.Size = UDim2.new(1, -70, 0, 16)
    nameLabel.BackgroundTransparency = 1
    nameLabel.Text = "KEY ACTIVE"
    nameLabel.TextColor3 = COL_SUCCESS
    nameLabel.Font = Enum.Font.GothamBold
    nameLabel.TextSize = 10
    nameLabel.TextXAlignment = Enum.TextXAlignment.Left
    nameLabel.Parent = panel

    local closeButton = Instance.new("TextButton")
    closeButton.AnchorPoint = Vector2.new(1, 0)
    closeButton.Position = UDim2.new(1, -8, 0, 6)
    closeButton.Size = UDim2.new(0, 22, 0, 22)
    closeButton.BackgroundTransparency = 1
    closeButton.Text = "×"
    closeButton.TextColor3 = COL_MUTED
    closeButton.TextSize = 16
    closeButton.Font = Enum.Font.Gotham
    closeButton.AutoButtonColor = false
    closeButton.Parent = panel

    local timerLabel = Instance.new("TextLabel")
    timerLabel.Position = UDim2.new(0, 14, 0, 30)
    timerLabel.Size = UDim2.new(1, -28, 0, 24)
    timerLabel.BackgroundTransparency = 1
    timerLabel.Text = "00:00:00"
    timerLabel.TextColor3 = COL_TEXT
    timerLabel.Font = Enum.Font.Code
    timerLabel.TextSize = 19
    timerLabel.TextXAlignment = Enum.TextXAlignment.Left
    timerLabel.Parent = panel

    local progressTrack = Instance.new("Frame")
    progressTrack.Position = UDim2.new(0, 14, 0, 60)
    progressTrack.Size = UDim2.new(1, -28, 0, 3)
    progressTrack.BackgroundColor3 = COL_INPUT
    progressTrack.BorderSizePixel = 0
    progressTrack.Parent = panel
    local progressTrackCorner = Instance.new("UICorner")
    progressTrackCorner.CornerRadius = UDim.new(1, 0)
    progressTrackCorner.Parent = progressTrack
    local progressFill = Instance.new("Frame")
    progressFill.Size = UDim2.new(1, 0, 1, 0)
    progressFill.BackgroundColor3 = COL_SUCCESS
    progressFill.BorderSizePixel = 0
    progressFill.Parent = progressTrack
    local progressFillCorner = Instance.new("UICorner")
    progressFillCorner.CornerRadius = UDim.new(1, 0)
    progressFillCorner.Parent = progressFill
    local progressFillGradient = Instance.new("UIGradient")
    progressFillGradient.Color = ColorSequence.new(COL_SUCCESS, COL_CYAN)
    progressFillGradient.Parent = progressFill

    local expiryLabel = Instance.new("TextLabel")
    expiryLabel.Position = UDim2.new(0, 14, 0, 70)
    expiryLabel.Size = UDim2.new(1, -28, 0, 14)
    expiryLabel.BackgroundTransparency = 1
    expiryLabel.TextColor3 = COL_MUTED
    expiryLabel.Font = Enum.Font.Gotham
    expiryLabel.TextSize = 9
    expiryLabel.TextXAlignment = Enum.TextXAlignment.Left
    expiryLabel.TextTruncate = Enum.TextTruncate.AtEnd
    expiryLabel.Parent = panel

    local fileLabel = Instance.new("TextLabel")
    fileLabel.Position = UDim2.new(0, 14, 0, 85)
    fileLabel.Size = UDim2.new(1, -28, 0, 14)
    fileLabel.BackgroundTransparency = 1
    fileLabel.TextColor3 = COL_MUTED
    fileLabel.TextTransparency = 0.25
    fileLabel.Font = Enum.Font.Gotham
    fileLabel.TextSize = 8
    fileLabel.TextXAlignment = Enum.TextXAlignment.Left
    fileLabel.TextTruncate = Enum.TextTruncate.AtEnd
    fileLabel.Parent = panel

    timerLabel.Text = type(remainingSeconds) == "number" and formatClock(remainingSeconds) or "--:--:--"
    expiryLabel.Text = type(expiresAtMs) == "number" and "Checking expiry..." or "Key is permanent"
    fileLabel.Text = fileSaved and "Saved on this device" or "Device save unavailable"

    local dismissing = false
    local function dismissStatusNotice()
        if dismissing or not panel.Parent then return end
        dismissing = true
        TweenService:Create(panel, TweenInfo.new(0.2, EASE_OUT), {
            Position = UDim2.new(1, -14, 1, 18),
            BackgroundTransparency = 1
        }):Play()
        TweenService:Create(panelStroke, TweenInfo.new(0.18, EASE_OUT), { Transparency = 1 }):Play()
        TweenService:Create(panelScale, TweenInfo.new(0.2, EASE_OUT), { Scale = 0.94 }):Play()
        for _, textObject in ipairs({ nameLabel, timerLabel, expiryLabel, fileLabel, closeButton }) do
            TweenService:Create(textObject, TweenInfo.new(0.16, EASE_OUT), { TextTransparency = 1 }):Play()
        end
        task.delay(0.22, function()
            if screenGui.Parent then screenGui:Destroy() end
        end)
    end
    closeButton.Activated:Connect(dismissStatusNotice)

    if type(remainingSeconds) ~= "number" then
        expiryLabel.Text = "Key is permanent"
        timerLabel.Text = "PERMANENT"
        progressFill.Size = UDim2.new(1, 0, 1, 0)
        task.delay(6, dismissStatusNotice)
        return
    end

    local secondsLeft = math.max(0, math.floor(remainingSeconds))
    local lifetimeSeconds = math.max(1, secondsLeft)
    expiryLabel.Text = "Expires in " .. formatKeyTime(secondsLeft)
    task.spawn(function()
        while panel.Parent and secondsLeft > 0 do
            timerLabel.Text = formatClock(secondsLeft)
            expiryLabel.Text = "Expires in " .. formatKeyTime(secondsLeft)
            TweenService:Create(progressFill, TweenInfo.new(0.9, Enum.EasingStyle.Linear), {
                Size = UDim2.new(math.clamp(secondsLeft / lifetimeSeconds, 0, 1), 0, 1, 0)
            }):Play()
            task.wait(1)
            secondsLeft -= 1
        end
    end)
    task.delay(lifetimeSeconds, function()
        clearSavedKey()
        if panel.Parent then
            timerLabel.Text = "EXPIRED"
            expiryLabel.Text = "Key expired · get a new key to run again"
            expiryLabel.TextColor3 = COL_DANGER
            nameLabel.Text = "KEY EXPIRED"
            nameLabel.TextColor3 = COL_DANGER
            nameDot.BackgroundColor3 = COL_DANGER
            accentLine.BackgroundColor3 = COL_DANGER
            progressFill.Size = UDim2.new(0, 0, 1, 0)
            if fileSaved then fileLabel.Text = "Local copy cleared after expiry" end
        end
    end)
    task.delay(6, dismissStatusNotice)
end

local function shakeCard()
    local originalPos = card.Position
    local seq = {
        UDim2.new(originalPos.X.Scale, originalPos.X.Offset - 9, originalPos.Y.Scale, originalPos.Y.Offset),
        UDim2.new(originalPos.X.Scale, originalPos.X.Offset + 9, originalPos.Y.Scale, originalPos.Y.Offset),
        UDim2.new(originalPos.X.Scale, originalPos.X.Offset - 5, originalPos.Y.Scale, originalPos.Y.Offset),
        originalPos
    }
    for _, pos in ipairs(seq) do
        TweenService:Create(card, TweenInfo.new(0.06, Enum.EasingStyle.Linear), { Position = pos }):Play()
        task.wait(0.06)
    end
    TweenService:Create(inputStroke, TweenInfo.new(0.35, EASE_OUT), { Color = COL_DANGER }):Play()
    TweenService:Create(inputStroke, TweenInfo.new(0.4, EASE_OUT, Enum.EasingDirection.Out, 0, false, 0.3), { Color = COL_LINE }):Play()
end

getKeyBtn.Activated:Connect(function()
    TweenService:Create(getKeyScale, TweenInfo.new(0.09, EASE_OUT), { Scale = 0.97 }):Play()
    task.delay(0.1, function()
        if getKeyBtn.Parent then TweenService:Create(getKeyScale, TweenInfo.new(0.16, EASE_OUT), { Scale = 1 }):Play() end
    end)
    local copied = pcall(function() setclipboard(${luaString(keyPageUrl)}) end)
    if copied then
        setStatus("Link copied. Paste it in your browser.", COL_SUCCESS)
    else
        setStatus("Get a key at: ${keyPageUrl}", COL_MUTED)
    end
end)

local verifying = false
local dotsRunning = false

local function animateDots(label, baseText)
    dotsRunning = true
    task.spawn(function()
        local dots = 0
        while dotsRunning do
            label.Text = baseText .. string.rep(".", dots % 4)
            dots += 1
            task.wait(0.32)
        end
    end)
end

local function bur(effectColor, position)
    for ringIndex = 1, 2 do
        task.delay((ringIndex - 1) * 0.12, function()
            if not card.Parent then return end
            local ring = Instance.new("Frame")
            ring.AnchorPoint = Vector2.new(0.5, 0.5)
            ring.Position = position
            ring.Size = UDim2.new(0, 20, 0, 20)
            ring.BackgroundTransparency = 1
            ring.BorderSizePixel = 0
            ring.ZIndex = 9
            ring.Parent = content
            local ringCorner = Instance.new("UICorner")
            ringCorner.CornerRadius = UDim.new(1, 0)
            ringCorner.Parent = ring
            local ringStroke = Instance.new("UIStroke")
            ringStroke.Color = effectColor
            ringStroke.Thickness = 2
            ringStroke.Transparency = 0.2
            ringStroke.Parent = ring
            TweenService:Create(ring, TweenInfo.new(0.7, Enum.EasingStyle.Sine, Enum.EasingDirection.Out), {
                Size = UDim2.new(0, 180, 0, 180)
            }):Play()
            TweenService:Create(ringStroke, TweenInfo.new(0.7, Enum.EasingStyle.Sine, Enum.EasingDirection.Out), {
                Transparency = 1
            }):Play()
            task.delay(0.75, function()
                if ring.Parent then ring:Destroy() end
            end)
        end)
    end
end

local function attemptVerify(fromSavedKey)
    if verifying then return end
    local typedKey = inputBox.Text
    if typedKey == "" then
        setStatus("Enter a key first.", COL_DANGER)
        shakeCard()
        return
    end

    verifying = true
    setStatus("", COL_MUTED)
    animateDots(submitLabel, "Verifying")

    local ok, response = vxFetch(
        "${verifyBase}" ..
        "&key=" .. HttpService:UrlEncode(typedKey) ..
        vxClientParams(player)
    )

    dotsRunning = false
    verifying = false
    submitLabel.Text = ${luaString(appearance.buttonLabel)}

    if not ok then
        setStatus("Couldn't reach the server. Try again.", COL_DANGER)
        shakeCard()
        return
    end

    local decodeOk, result = vxPcall(vxJsonDecode, HttpService, response)
    if not decodeOk or type(result) ~= "table" then
        setStatus("Bad response from server.", COL_DANGER)
        shakeCard()
        return
    end

    if not result.ok then
        if result.code == "vault_removed" then
            screenGui:Destroy()
            ${buildRemovedVaultGui()}
            return
        end
        local failureMessage = tostring(result.message or "Invalid key.")
        if fromSavedKey then
            local lowerMessage = string.lower(failureMessage)
            local keyNeedsRenewal = string.find(lowerMessage, "invalid key", 1, true)
                or string.find(lowerMessage, "expired", 1, true)
                or string.find(lowerMessage, "terminated", 1, true)
            if keyNeedsRenewal then
                clearSavedKey()
                inputBox.Text = ""
                setStatus("Saved key expired or changed. Enter your current key.", COL_DANGER)
            else
                setStatus(failureMessage, COL_DANGER)
            end
        else
            setStatus(failureMessage, COL_DANGER)
        end
        shakeCard()
        return
    end

    local fileSaved = saveKeyLocally(typedKey)
    setStatus(fileSaved and "Key verified. Saved on this device." or "Key verified. Local saving unavailable.", COL_SUCCESS)
    stateLabel.Text = "VERIFIED"
    stateLabel.TextColor3 = COL_SUCCESS
    stateDot.BackgroundColor3 = COL_SUCCESS
    submitBtn.Active = false
    submitLabel.Text = "Access granted"
    submitLabel.TextColor3 = COL_INK
    btnGradient.Color = ColorSequence.new(COL_SUCCESS, COL_CYAN)
    brandGradient.Color = ColorSequence.new(COL_SUCCESS, COL_CYAN)
    brandLetter.Text = "✓"
    bur(COL_SUCCESS, UDim2.new(0, 24, 0, 28))
    TweenService:Create(uiScale, TweenInfo.new(0.16, EASE_OUT), { Scale = cardScale * 1.035 }):Play()
    task.wait(0.2)
    TweenService:Create(uiScale, TweenInfo.new(0.3, EASE_OUT), { Scale = cardScale * 0.9 }):Play()
    TweenService:Create(card, TweenInfo.new(0.3, EASE_OUT), {
        BackgroundTransparency = 1,
        Position = UDim2.new(0.5, 0, 0.5, 16)
    }):Play()
    TweenService:Create(cardStroke, TweenInfo.new(0.26, EASE_OUT), { Transparency = 1 }):Play()
    TweenService:Create(overlay, TweenInfo.new(0.34, EASE_OUT), { BackgroundTransparency = 1 }):Play()
    for _, child in ipairs(content:GetChildren()) do
        if child:IsA("TextLabel") or child:IsA("TextButton") or child:IsA("TextBox") then
            TweenService:Create(child, TweenInfo.new(0.2, EASE_OUT), { TextTransparency = 1 }):Play()
        end
    end
    task.wait(0.3)

    card:Destroy()
    overlay:Destroy()
    showKeyTimer(result.remainingSeconds, fileSaved, result.expiresAt)
    vxRunPayload(result.token, player.UserId, result.shield, result.report, result.delivery)
end

submitBtn.Activated:Connect(function()
    TweenService:Create(btnScale, TweenInfo.new(0.09, EASE_OUT), { Scale = 0.975 }):Play()
    task.delay(0.1, function()
        if submitBtn.Parent then TweenService:Create(btnScale, TweenInfo.new(0.16, EASE_OUT), { Scale = 1 }):Play() end
    end)
    attemptVerify()
end)
inputBox.FocusLost:Connect(function(enterPressed)
    if enterPressed then attemptVerify() end
end)

local previouslySavedKey = readSavedKey()
if previouslySavedKey then
    inputBox.Text = previouslySavedKey
    setStatus("Checking the saved key...", COL_MUTED)
    task.defer(function() attemptVerify(true) end)
end
`);
}
