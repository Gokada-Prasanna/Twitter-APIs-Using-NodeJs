const express = require("express");
const path = require("path");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const dbPath = path.join(__dirname, "twitterClone.db");

const app = express();
app.use(express.json());

let db = null;

const initializeDatabaseAndServer = async () => {
  try {
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });
    app.listen(3000, () => {
      console.log("Server Running at http://localhost:3000/");
    });
  } catch (e) {
    console.log(`DB Error : ${e.message}`);
    process.exit(1);
  }
};

initializeDatabaseAndServer();

const validatePassword = (password) => {
  return password.length > 6;
};

const getUserId = async (username) => {
  const userIdQuery = `
SELECT * FROM user
WHERE username='${username}';
`;
  const userId = await db.get(userIdQuery);
  return userId.user_id;
};

app.post("/register/", async (request, response) => {
  const { username, password, name, gender } = request.body;
  //Checking If user already exits
  const selectUserQuery = `
    SELECT
      * 
    FROM
      user
    WHERE
      username = '${username}';`;
  const dbUser = await db.get(selectUserQuery);
  if (dbUser === undefined) {
    const hashedPassword = await bcrypt.hash(password, 10);

    const createUserQuery = `
      INSERT INTO 
        user (name, username, password, gender) 
      VALUES 
        ('${name}', '${username}', '${hashedPassword}', '${gender}');`;
    if (validatePassword(password)) {
      await db.run(createUserQuery);
      response.send("User created successfully");
    } else {
      response.status(400);
      response.send("Password is too short");
    }
  } else {
    response.status(400);
    response.send("User already exists");
  }
});

app.post("/login/", async (request, response) => {
  const { username, password } = request.body;
  const selectUserQuery = `
SELECT * FROM user 
WHERE username='${username}';
`;
  const dbUser = await db.get(selectUserQuery);

  if (dbUser === undefined) {
    response.status(400);
    response.send("Invalid user");
  } else {
    const isPasswordMatched = await bcrypt.compare(password, dbUser.password);
    if (isPasswordMatched === true) {
      const payload = {
        username: username,
      };
      const jwtToken = jwt.sign(payload, "MY_SECRET_TOKEN");
      response.send({ jwtToken });
    } else {
      response.status(400);
      response.send("Invalid password");
    }
  }
});

function authentication(request, response, next) {
  let jwtToken;
  const authHeader = request.headers["authorization"];
  if (authHeader !== undefined) {
    jwtToken = authHeader.split(" ")[1];
  }
  if (jwtToken === undefined) {
    response.status(401);
    response.send("Invalid JWT Token");
  } else {
    jwt.verify(jwtToken, "MY_SECRET_TOKEN", (error, payload) => {
      if (error) {
        response.status(401);
        response.send("Invalid JWT Token");
      } else {
        request.username = payload.username;
        next();
      }
    });
  }
}

app.get("/user/tweets/feed/", authentication, async (request, response) => {
  const { username } = request;
  const userId = await getUserId(username);
  const getTweetsQuery = `
  SELECT username, tweet, date_time AS dateTime FROM 
  (follower INNER JOIN  tweet on follower.following_user_id = tweet.user_id)
  AS T NATURAL JOIN user
  WHERE follower.follower_user_id = ${userId}
  ORDER BY 
  date_time DESC
  LIMIT 4;
  `;

  const tweets = await db.all(getTweetsQuery);
  response.send(tweets);
});

app.get("/user/following/", authentication, async (request, response) => {
  const { username } = request;

  const userId = await getUserId(username);

  const getFollowingNamesQuery = `
    SELECT 
      name
    FROM 
      user INNER JOIN follower
    ON 
      user.user_id = follower.following_user_id
    WHERE follower.follower_user_id = ${userId};`;

  const getFollowingUsersNamesList = await db.all(getFollowingNamesQuery);
  response.send(getFollowingUsersNamesList);
});

app.get("/user/followers/", authentication, async (request, response) => {
  const { username } = request;

  const userId = await getUserId(username);

  const getFollowingNamesQuery = `
    SELECT 
      name
    FROM 
      user INNER JOIN follower
    ON 
      user.user_id = follower.follower_user_id
    WHERE follower.following_user_id = ${userId};`;

  const getFollowingUsersNamesList = await db.all(getFollowingNamesQuery);
  response.send(getFollowingUsersNamesList);
});

app.get("/tweets/:tweetId/", authentication, async (request, response) => {
  const { tweetId } = request.params;
  const { username } = request;

  const userId = await getUserId(username);
  const getTweetQuery = `
  SELECT * FROM tweet WHERE tweet_id = ${tweetId};
  `;
  const tweetInfo = await db.get(getTweetQuery);

  const followingUsersQuery = `
    SELECT following_user_id FROM follower 
    WHERE follower_user_id = ${userId};
  `;
  const followingUsersObjectsList = await db.all(followingUsersQuery);
  const followingUsersList = followingUsersObjectsList.map((object) => {
    return object["following_user_id"];
  });
  if (!followingUsersList.includes(tweetInfo.user_id)) {
    response.status(401);
    response.send("Invalid Request");
  } else {
    const { tweet_id, date_time, tweet } = tweetInfo;
    const getLikesQuery = `
    SELECT COUNT(like_id) AS likes FROM like 
    WHERE tweet_id = ${tweet_id} GROUP BY tweet_id;
    `;
    const likesObject = await db.get(getLikesQuery);
    const getRepliesQuery = `
    SELECT COUNT(reply_id) AS replies FROM reply 
    WHERE tweet_id = ${tweet_id} GROUP BY tweet_id;
    `;
    const repliesObject = await db.get(getRepliesQuery);
    response.send({
      tweet,
      likes: likesObject.likes,
      replies: repliesObject.replies,
      dateTime: date_time,
    });
  }
});

const follows = async (request, response, next) => {
  const { tweetId } = request.params;
  let isFollowing = await db.get(`
      select * from follower
      where
      follower_user_id =  (select user_id from user where username = "${request.username}")
      and 
      following_user_id = (select user.user_id from tweet natural join user where tweet_id = ${tweetId});
      `);
  if (isFollowing === undefined) {
    response.status(401);
    response.send("Invalid Request");
  } else {
    next();
  }
};

app.get(
  "/tweets/:tweetId/likes/",
  authentication,
  async (request, response) => {
    const { tweetId } = request.params;
    const { username } = request;
    const userId = await getUserId(username);
    const getTweetQuery = `
  SELECT * FROM tweet WHERE tweet_id = ${tweetId};
  `;
    const tweetInfo = await db.get(getTweetQuery);

    const followingUsersQuery = `
    SELECT following_user_id FROM follower 
    WHERE follower_user_id = ${userId};
  `;
    const followingUsersObjectsList = await db.all(followingUsersQuery);
    const followingUsersList = followingUsersObjectsList.map((object) => {
      return object["following_user_id"];
    });
    if (!followingUsersList.includes(tweetInfo.user_id)) {
      response.status(401);
      response.send("Invalid Request");
    } else {
      const { tweet_id, date_time } = tweetInfo;
      const getLikesQuery = `
        SELECT user_id FROM like 
        WHERE tweet_id = ${tweet_id};
        `;
      const likedUserIdObjectsList = await db.all(getLikesQuery);
      const likedUserIdsList = likedUserIdObjectsList.map((object) => {
        return object.user_id;
      });
      const getLikedUsersQuery = `
      SELECT username FROM user 
      WHERE user_id IN (${likedUserIdsList});
      `;
      const likedUsersObjectsList = await db.all(getLikedUsersQuery);
      const likedUsersList = likedUsersObjectsList.map((object) => {
        return object.username;
      });
      response.send({
        likes: likedUsersList,
      });
    }
  }
);

app.get(
  "/tweets/:tweetId/replies/",
  authentication,
  follows,
  async (request, response) => {
    const { tweetId } = request.params;
    const replies = await db.all(`
    select user.name, reply.reply from
    reply natural join user
    where tweet_id = ${tweetId};
    `);
    response.send({ replies });
  }
);

app.get("/user/tweets/", authentication, async (request, response) => {
  const myTweets = await db.all(`
    select 
    tweet.tweet,
    count(distinct like.like_id) as likes,
    count(distinct reply.reply_id) as replies,
    tweet.date_time
    from
    tweet
    left join like on tweet.tweet_id = like.tweet_id
    left join reply on tweet.tweet_id = reply.tweet_id
    where tweet.user_id = (select user_id from user where username = "${request.username}")
    group by tweet.tweet_id;
    `);
  response.send(
    myTweets.map((item) => {
      const { date_time, ...rest } = item;
      return { ...rest, dateTime: date_time };
    })
  );
});

app.post("/user/tweets/", authentication, async (request, response) => {
  const { username } = request;
  const userId = await getUserId(username);

  const { tweet } = request.body;
  const dateString = new Date().toISOString();
  const dateTime = dateString.slice(0, 10) + " " + dateString.slice(11, 19);
  const addNewTweetQuery = `
  INSERT INTO tweet (tweet, user_id, date_time) 
  VALUES ('${tweet}', ${userId}, '${dateTime}');
  `;
  await db.run(addNewTweetQuery);
  response.send("Created a Tweet");
});

app.delete("/tweets/:tweetId/", authentication, async (request, response) => {
  const { tweetId } = request.params;
  const { username } = request;
  const userId = await getUserId(username);

  const getTweetQuery = `
  SELECT * FROM tweet WHERE tweet_id = ${tweetId};
  `;
  const tweetInfo = await db.get(getTweetQuery);
  if (userId !== tweetInfo.user_id) {
    response.status(401);
    response.send("Invalid Request");
  } else {
    const deleteTweetQuery = `
      DELETE FROM tweet WHERE tweet_id = ${tweetId};
      `;
    await db.run(deleteTweetQuery);
    response.send("Tweet Removed");
  }
});

module.exports = app;
