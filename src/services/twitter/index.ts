import db from '@/database'
import * as DBTypes from '@/database/types'
import { TweetEntitiesV1, TweetV1, UserEntitiesV1 } from 'twitter-api-v2'
import client from './client'
import listManager from './lists'
import utils from '@/utils'

const list = listManager.instance
const logger = utils.logger.getLogger('twitter')

async function nameResolver(search: 'uid' | 'screen_name', key: string) {
    const item = await db.getOne<DBTypes.ITwitterUser>('twitterUser', { [search]: key })
    const isFound = !!(item && Object.keys(item).length)

    return {
        success: isFound,
        result: isFound ? {
            uid: item.uid,
            screen_name: item.screen_name,
            updatedAt: item.updatedAt
        } : null
    }
}

async function getUser(id: string, search = 'screen_name' as 'uid' | 'screen_name', forceFetch = false) {
    // データベースからユーザーのキャッシュを取得
    const cachedUser = await db.getOne<DBTypes.ITwitterUser>('twitterUser', { [search]: id })

    // キャッシュが存在し、かつキャッシュが有効な場合はキャッシュを返す
    const CACHE_LIMIT = 1000 * 60 * 60 * 24 // 1 day
    if (cachedUser && (Date.now() - cachedUser.updatedAt) < CACHE_LIMIT && !forceFetch) {
        return cachedUser.user
    }

    const twitterSearchType = search === 'uid' ? 'user_id' : 'screen_name'

    // キャッシュが存在しない、またはキャッシュが無効な場合はAPIから取得
    const user = await client.v1.user({
        [twitterSearchType]: id,
    } as any).catch((e) => {
        logger.error(e)
        return null
    }) as DBTypes.ITwitterUserProfile | null

    // ユーザーが見つからなければnullを返す
    if (!user) return null

    if (user.status) delete user.status

    const upsertObject = {
        screen_name: user.screen_name,
        uid: user.id_str,
        user: user,
        updatedAt: Date.now()
    } as DBTypes.ITwitterUser

    // ユーザーが見つかった場合はキャッシュを更新
    db.upsertOne('twitterUser', { uid: user.id_str }, upsertObject)

    logger.info(`User ${user.screen_name} (${user.id_str}) is fetched from Twitter API.`)

    // 返す
    return user
}

async function getTweet(id: string, forceFetch = false) {
    // データベースからツイートのキャッシュを取得
    const cachedTweet = await db.getOne<DBTypes.ITwitterTweet>('twitterTweet', { id })

    // キャッシュが存在し、かつキャッシュが有効な場合はキャッシュを返す
    const CACHE_LIMIT = 1000 * 60 * 60 * 24 * 30 // 1 month
    if (cachedTweet && (Date.now() - cachedTweet.updatedAt) < CACHE_LIMIT && !forceFetch) {
        return cachedTweet.tweet
    }

    // キャッシュが存在しない、またはキャッシュが無効な場合はAPIから取得
    const tweet = await client.v1.singleTweet(id, {
        tweet_mode: 'extended'
    }).catch((e) => {
        logger.error(e)
        return null
    })

    // ツイートが見つからなければnullを返す
    if (!tweet) return null

    // キャッシュ更新
    insertTweet(tweet)

    logger.info(`Tweet ${tweet.id_str} is fetched from Twitter API.`)

    // 返す
    return tweet
}

async function insertTweet(tweet: TweetV1) {
    const upsertObject = {
        id: tweet.id_str,
        authorUid: tweet.user.id_str,
        tweet: tweet,
        updatedAt: Date.now()
    } as DBTypes.ITwitterTweet

    await db.upsertOne('twitterTweet', { id: tweet.id_str }, upsertObject)
}

function replaceRawLinks(text: string | null | undefined, entities: UserEntitiesV1 | TweetEntitiesV1 | undefined) {
    if (!text || !entities) return ''

    const targets = []

    // TweetEntitiesV1
    if ('urls' in entities && entities.urls) {
        targets.push(...entities.urls)
    }

    // UserEntitiesV1
    if ('url' in entities && entities.url) {
        if (entities.url?.urls) targets.push(...entities.url.urls)
        if (entities.description?.urls) targets.push(...entities.description.urls)
    }

    for (const target of targets) {
        text = text.replace(target.url, target.expanded_url)
    }

    return text
}

function removeMediaLinks(text: string, entities: TweetEntitiesV1) {
    if (!entities.media) return text

    for (const media of entities.media) {
        text = text.replace(media.url, '')
    }

    return text
}

async function followUser(remoteUser: string, targetUser: DBTypes.ITwitterUserProfile) {
    // すでにリストに追加されているか確認
    const alreadyLinked = await db.getOne<DBTypes.IFollowingList>('userListLink', { target: targetUser.id_str })
    if (!alreadyLinked) {
        // 初期化されてなければ終了
        if (!list.isInitialized) return false

        // リストに追加
        const result = await list.follow(targetUser.id_str)
        if (!result) return false

        // リストの紐づけテーブルに追加
        const upsertObject = {
            target: targetUser.id_str,
            list: result,
            updatedAt: Date.now()
        } as DBTypes.IUserListLink
        await db.upsertOne('userListLink', { target: targetUser.id_str }, upsertObject)
    }

    const upsertObject = {
        source: remoteUser,
        target: targetUser.id_str,
        updatedAt: Date.now()
    } as DBTypes.IFollowingList

    await db.upsertOne('followingList', { source: remoteUser, target: targetUser.id_str }, upsertObject)

    logger.info(`Followed ${targetUser.screen_name} by ${remoteUser}`)
    return true
}

async function unfollowUser(remoteUser: string, targetUser: DBTypes.ITwitterUserProfile) {
    await db.deleteOne('followingList', { source: remoteUser, target: targetUser.id_str })
    logger.info(`Unfollowed ${targetUser.screen_name} by ${remoteUser}`)
}

export default {
    nameResolver,
    getUser,
    getTweet,
    insertTweet,
    replaceRawLinks,
    removeMediaLinks,
    followUser,
    unfollowUser,
    client,
    list
}